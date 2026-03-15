import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  TerminalHandle,
  ndJsonStream,
  type Agent as ACPAgent,
  type AgentCapabilities,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type ContentBlock,
  type EmbeddedResource,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionInfo,
} from "@agentclientprotocol/sdk";
import type TokenRingAgent from "@tokenring-ai/agent/Agent";
import type {AgentEventEnvelope, InputAttachment} from "@tokenring-ai/agent/AgentEvents";
import type {ParsedAgentConfig} from "@tokenring-ai/agent/schema";
import {AgentEventState} from "@tokenring-ai/agent/state/agentEventState";
import AgentManager from "@tokenring-ai/agent/services/AgentManager";
import TokenRingApp from "@tokenring-ai/app";
import type {TokenRingService} from "@tokenring-ai/app/types";
import type FileSystemService from "../filesystem/FileSystemService.ts";
import type TerminalService from "../terminal/TerminalService.ts";
import type {ExecuteCommandOptions, ExecuteCommandResult} from "../terminal/TerminalProvider.ts";
import {randomUUID} from "node:crypto";
import path from "node:path";
import process from "node:process";
import {Readable, Writable} from "node:stream";
import {setTimeout as delay} from "node:timers/promises";
import packageJSON from "./package.json" with {type: "json"};
import type {ACPConfig} from "./schema.ts";

type ACPPromptState = {
  requestId: string;
};

type ACPSession = {
  sessionId: string;
  cwd: string;
  agent: TokenRingAgent;
  activePrompt: ACPPromptState | null;
  updatedAt: string;
};

type ACPManagedTerminal = {
  agentId: string;
  handle: TerminalHandle;
  sessionId: string;
  terminalId: string;
};

type StreamMessageIds = {
  assistant: string;
  thought: string;
};

type ACPAgentConfig = ParsedAgentConfig & {
  filesystem?: Record<string, unknown>;
  terminal?: Record<string, unknown>;
};

type FileSystemStateLike = {
  workingDirectory: string;
};

type TerminalSessionStateLike = {
  id: string;
  command: string;
  lastPosition: number;
  startTime: number;
  running: boolean;
};

type TerminalStateLike = {
  workingDirectory: string;
  bash: {
    cropOutput: number;
  };
  getSession(id: string): TerminalSessionStateLike | undefined;
  registerSession(id: string, command: string): void;
  updateSessionPosition(id: string, position: number): void;
  removeSession(id: string): void;
};

export default class ACPService implements TokenRingService {
  readonly name = "ACPService";
  description = "ACP (Agent Client Protocol) server for TokenRing agents";

  private connection: AgentSideConnection | null = null;
  private clientCapabilities: ClientCapabilities = {};
  private readonly sessions = new Map<string, ACPSession>();
  private readonly sessionsByAgentId = new Map<string, ACPSession>();
  private readonly terminalHandles = new Map<string, ACPManagedTerminal>();
  private servicesPatched = false;

  constructor(
    private readonly app: TokenRingApp,
    private readonly config: ACPConfig,
  ) {}

  start(): void {
    if (this.config.transport !== "stdio") {
      throw new Error(`Unsupported ACP transport: ${this.config.transport}`);
    }

    const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
    const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);

    this.connection = new AgentSideConnection(
      (connection) => new TokenRingACPAgent(connection, this),
      stream,
    );

    this.patchServices();
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.connection) {
      throw new Error("ACP connection was not initialized");
    }

    await Promise.race([
      this.connection.closed,
      waitForAbort(signal),
    ]);

    if (!signal.aborted) {
      this.app.shutdown("ACP connection closed");
    }
  }

  async stop(): Promise<void> {
    await this.cleanupSessions("ACP service stopping");
  }

  initialize(params: InitializeRequest): InitializeResponse {
    this.clientCapabilities = params.clientCapabilities ?? {};

    const agentCapabilities: AgentCapabilities = {
      loadSession: false,
      promptCapabilities: {
        embeddedContext: true,
        image: true,
        audio: true,
      },
      sessionCapabilities: {
        list: {},
      },
    };

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities,
      agentInfo: {
        name: packageJSON.name,
        title: "TokenRing ACP",
        version: packageJSON.version,
      },
    };
  }

  async createSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = this.validateSessionCwd(params.cwd);
    const agentManager = this.app.requireService(AgentManager);
    const configuredAgentType = this.config.defaultAgentType;
    const configuredAgentConfig = configuredAgentType
      ? agentManager.getAgentConfig(configuredAgentType)
      : undefined;
    const fallbackAgentType = agentManager.getAgentTypes()[0];
    const baseAgentConfig = configuredAgentConfig
      ?? (fallbackAgentType ? agentManager.getAgentConfig(fallbackAgentType) : undefined);

    if (!baseAgentConfig) {
      throw new Error("No agent types are registered");
    }

    const sessionAgentConfig: ACPAgentConfig = {
      ...(baseAgentConfig as ACPAgentConfig),
      headless: true,
      filesystem: {
        ...asRecord((baseAgentConfig as ACPAgentConfig).filesystem),
        workingDirectory: cwd,
      },
      terminal: {
        ...asRecord((baseAgentConfig as ACPAgentConfig).terminal),
        workingDirectory: cwd,
      },
    };

    const agent = await agentManager.spawnAgentFromConfig(sessionAgentConfig as ParsedAgentConfig);

    const sessionId = randomUUID();
    const session: ACPSession = {
      sessionId,
      cwd,
      agent,
      activePrompt: null,
      updatedAt: new Date().toISOString(),
    };

    this.decorateAgent(session);
    this.sessions.set(sessionId, session);
    this.sessionsByAgentId.set(agent.id, session);

    await this.sendSessionInfoUpdate(session);

    return {
      sessionId,
    };
  }

  listSessions(params: ListSessionsRequest): ListSessionsResponse {
    let cwdFilter: string | undefined;
    if (params.cwd) {
      cwdFilter = this.validateSessionCwd(params.cwd);
    }

    const sessions = Array.from(this.sessions.values())
      .filter((session) => !cwdFilter || session.cwd === cwdFilter)
      .map((session): SessionInfo => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.agent.displayName,
        updatedAt: session.updatedAt,
      }));

    return {sessions};
  }

  requireSession(sessionId: string): ACPSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams({sessionId}, `Session ${sessionId} was not found`);
    }
    return session;
  }

  async prompt(
    connection: AgentSideConnection,
    params: PromptRequest,
  ): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.activePrompt) {
      throw RequestError.invalidRequest(
        {sessionId: params.sessionId},
        `Session ${params.sessionId} already has an active prompt`,
      );
    }

    const {message, attachments} = convertPromptToAgentInput(params.prompt);
    const cursor = session.agent
      .getState(AgentEventState)
      .getEventCursorFromCurrentPosition();
    const requestId = session.agent.handleInput({
      from: "ACP prompt",
      message,
      ...(attachments.length > 0 && {attachments}),
    });

    session.activePrompt = {requestId};
    session.updatedAt = new Date().toISOString();
    await this.sendSessionInfoUpdate(session);

    const messageIds: StreamMessageIds = {
      assistant: randomUUID(),
      thought: randomUUID(),
    };
    let sawAssistantOutput = false;
    const streamSignal = AbortSignal.any([
      connection.signal,
      session.agent.agentShutdownSignal,
    ]);

    try {
      for await (const state of session.agent.subscribeStateAsync(AgentEventState, streamSignal)) {
        for (const event of state.yieldEventsByCursor(cursor)) {
          const emittedAssistantOutput = await this.forwardEvent(
            connection,
            session,
            event,
            messageIds,
          );
          sawAssistantOutput ||= emittedAssistantOutput;

          if (event.type !== "agent.response" || event.requestId !== requestId) {
            continue;
          }

          if (!sawAssistantOutput || event.status !== "success") {
            await this.emitAssistantText(
              connection,
              session.sessionId,
              event.message,
              sawAssistantOutput && event.status !== "success"
                ? randomUUID()
                : messageIds.assistant,
            );
          }

          return {
            stopReason: event.status === "cancelled" ? "cancelled" : "end_turn",
            ...(params.messageId && {userMessageId: params.messageId}),
          };
        }
      }

      throw new Error(`Prompt stream for session ${session.sessionId} ended unexpectedly`);
    } finally {
      session.activePrompt = null;
      session.updatedAt = new Date().toISOString();
      await this.sendSessionInfoUpdate(session);
    }
  }

  cancel(params: CancelNotification): void {
    const session = this.sessions.get(params.sessionId);
    if (!session?.activePrompt) {
      return;
    }
    session.agent.abortCurrentOperation("ACP prompt cancelled by client");
  }

  private async forwardEvent(
    connection: AgentSideConnection,
    session: ACPSession,
    event: AgentEventEnvelope,
    messageIds: StreamMessageIds,
  ): Promise<boolean> {
    switch (event.type) {
      case "output.chat":
        await this.emitAssistantText(connection, session.sessionId, event.message, messageIds.assistant);
        return true;
      case "output.reasoning":
        await this.emitThoughtText(connection, session.sessionId, event.message, messageIds.thought);
        return false;
      case "output.info":
        await this.emitThoughtText(connection, session.sessionId, event.message, messageIds.thought);
        return false;
      case "output.warning":
        await this.emitThoughtText(connection, session.sessionId, `[warning] ${event.message}`, messageIds.thought);
        return false;
      case "output.error":
        await this.emitThoughtText(connection, session.sessionId, `[error] ${event.message}`, messageIds.thought);
        return false;
      case "output.artifact":
        await connection.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: messageIds.assistant,
            content: convertArtifactToContentBlock(event),
          },
        });
        return true;
      default:
        return false;
    }
  }

  private async emitAssistantText(
    connection: AgentSideConnection,
    sessionId: string,
    text: string,
    messageId: string,
  ): Promise<void> {
    if (!text.trim()) {
      return;
    }
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: {
          type: "text",
          text,
        },
      },
    });
  }

  private async emitThoughtText(
    connection: AgentSideConnection,
    sessionId: string,
    text: string,
    messageId: string,
  ): Promise<void> {
    if (!text.trim()) {
      return;
    }
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId,
        content: {
          type: "text",
          text,
        },
      },
    });
  }

  private async sendSessionInfoUpdate(session: ACPSession): Promise<void> {
    if (!this.connection) {
      return;
    }
    await this.connection.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: session.agent.displayName,
        updatedAt: session.updatedAt,
      },
    });
  }

  private decorateAgent(session: ACPSession): void {
    if (!this.connection) {
      throw new Error("ACP connection was not initialized");
    }

    const agent = session.agent as TokenRingAgent & {
      askForApproval: TokenRingAgent["askForApproval"];
      askForText: TokenRingAgent["askForText"];
      askQuestion: TokenRingAgent["askQuestion"];
    };

    agent.askForApproval = (async ({message, label = "Approve ?", default: defaultValue}) => {
      const response = await this.connection!.requestPermission({
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: randomUUID(),
          title: label,
          kind: "other",
          status: "pending",
          rawInput: {
            message,
            default: defaultValue ?? null,
          },
        },
        options: [
          {
            optionId: "allow",
            kind: "allow_once",
            name: label,
          },
          {
            optionId: "reject",
            kind: "reject_once",
            name: "Reject",
          },
        ],
      });

      if (response.outcome.outcome === "cancelled") {
        return null;
      }

      return response.outcome.optionId === "allow";
    }) as TokenRingAgent["askForApproval"];

    agent.askForText = (async () => {
      throw new Error("ACP mode does not support interactive text prompts");
    }) as TokenRingAgent["askForText"];

    agent.askQuestion = (async () => {
      throw new Error("ACP mode does not support arbitrary interactive questions");
    }) as TokenRingAgent["askQuestion"];
  }

  private validateSessionCwd(cwd: string): string {
    if (!path.isAbsolute(cwd)) {
      throw RequestError.invalidParams({cwd}, "ACP session cwd must be an absolute path");
    }

    return path.resolve(cwd);
  }

  private patchServices(): void {
    if (this.servicesPatched) {
      return;
    }
    this.servicesPatched = true;

    this.patchFileSystemService();
    this.patchTerminalService();
  }

  private patchFileSystemService(): void {
    const fileSystemService = this.getServiceByName<FileSystemService>("FileSystemService");
    if (!fileSystemService) {
      return;
    }

    const originalReadTextFile = fileSystemService.readTextFile.bind(fileSystemService);
    const originalReadFile = fileSystemService.readFile.bind(fileSystemService);
    const originalWriteFile = fileSystemService.writeFile.bind(fileSystemService);
    const originalAppendFile = fileSystemService.appendFile.bind(fileSystemService);

    fileSystemService.readTextFile = async (filePath: string, agent: TokenRingAgent) => {
      const session = this.getACPFileReadSession(agent);
      if (!session) {
        return originalReadTextFile(filePath, agent);
      }

      try {
        const response = await this.connection!.readTextFile({
          sessionId: session.sessionId,
          path: this.resolveACPAbsoluteFilePath(filePath, agent),
        });
        return response.content;
      } catch {
        return originalReadTextFile(filePath, agent);
      }
    };

    fileSystemService.readFile = async (filePath: string, agent: TokenRingAgent) => {
      const session = this.getACPFileReadSession(agent);
      if (!session) {
        return originalReadFile(filePath, agent);
      }

      try {
        const response = await this.connection!.readTextFile({
          sessionId: session.sessionId,
          path: this.resolveACPAbsoluteFilePath(filePath, agent),
        });
        return Buffer.from(response.content, "utf-8");
      } catch {
        return originalReadFile(filePath, agent);
      }
    };

    fileSystemService.writeFile = async (
      filePath: string,
      content: string | Buffer,
      agent: TokenRingAgent,
    ) => {
      const session = this.getACPFileWriteSession(agent);
      const textContent = toACPTextContent(content);
      if (!session || textContent === null) {
        return originalWriteFile(filePath, content, agent);
      }

      try {
        await this.connection!.writeTextFile({
          sessionId: session.sessionId,
          path: this.resolveACPAbsoluteFilePath(filePath, agent),
          content: textContent,
        });
        return true;
      } catch {
        return originalWriteFile(filePath, content, agent);
      }
    };

    fileSystemService.appendFile = async (
      filePath: string,
      content: string | Buffer,
      agent: TokenRingAgent,
    ) => {
      const session = this.getACPFileReadWriteSession(agent);
      const textContent = toACPTextContent(content);
      if (!session || textContent === null) {
        return originalAppendFile(filePath, content, agent);
      }

      try {
        const absolutePath = this.resolveACPAbsoluteFilePath(filePath, agent);
        const current = await this.connection!.readTextFile({
          sessionId: session.sessionId,
          path: absolutePath,
        });

        await this.connection!.writeTextFile({
          sessionId: session.sessionId,
          path: absolutePath,
          content: `${current.content}${textContent}`,
        });
        return true;
      } catch {
        return originalAppendFile(filePath, content, agent);
      }
    };
  }

  private patchTerminalService(): void {
    const terminalService = this.getServiceByName<TerminalService>("TerminalService");
    if (!terminalService) {
      return;
    }

    const originalExecuteCommand = terminalService.executeCommand.bind(terminalService);
    const originalRunScript = terminalService.runScript.bind(terminalService);
    const originalStartInteractiveSession = terminalService.startInteractiveSession.bind(terminalService);
    const originalSendInputToSession = terminalService.sendInputToSession.bind(terminalService);
    const originalTerminateSession = terminalService.terminateSession.bind(terminalService);
    const originalRetrieveSessionOutput = terminalService.retrieveSessionOutput.bind(terminalService);
    const originalGetCompleteSessionOutput = terminalService.getCompleteSessionOutput.bind(terminalService);

    terminalService.executeCommand = async (
      command: string,
      args: string[],
      options: Partial<ExecuteCommandOptions>,
      agent: TokenRingAgent,
    ) => {
      const session = this.getACPTerminalSession(agent);
      if (!session) {
        return originalExecuteCommand(command, args, options, agent);
      }

      return this.runACPCommand(session, agent, command, args, options);
    };

    terminalService.runScript = async (
      script: string,
      options: Partial<ExecuteCommandOptions>,
      agent: TokenRingAgent,
    ) => {
      const session = this.getACPTerminalSession(agent);
      if (!session) {
        return originalRunScript(script, options, agent);
      }

      const shell = process.env.SHELL || "/bin/bash";
      return this.runACPCommand(session, agent, shell, ["-lc", script], options);
    };

    terminalService.startInteractiveSession = async (agent: TokenRingAgent, command: string) => {
      const session = this.getACPTerminalSession(agent);
      if (!session) {
        return originalStartInteractiveSession(agent, command);
      }

      const shell = process.env.SHELL || "/bin/bash";
      const handle = await this.connection!.createTerminal({
        sessionId: session.sessionId,
        command: shell,
        args: ["-lc", command],
        cwd: this.resolveACPTerminalWorkingDirectory(agent),
      });

      this.terminalHandles.set(handle.id, {
        agentId: agent.id,
        handle,
        sessionId: session.sessionId,
        terminalId: handle.id,
      });

      this.getTerminalState(agent).registerSession(handle.id, command);

      return handle.id;
    };

    terminalService.sendInputToSession = async (
      sessionId: string,
      input: string,
      agent: TokenRingAgent,
    ) => {
      const handle = this.getManagedTerminal(sessionId, agent);
      if (!handle) {
        return originalSendInputToSession(sessionId, input, agent);
      }

      if (input.trim()) {
        throw new Error("ACP terminal sessions do not support stdin after creation");
      }
    };

    terminalService.terminateSession = async (sessionId: string, agent: TokenRingAgent) => {
      const handle = this.getManagedTerminal(sessionId, agent);
      if (!handle) {
        return originalTerminateSession(sessionId, agent);
      }

      await this.releaseManagedTerminal(handle, agent);
    };

    terminalService.retrieveSessionOutput = async (sessionId: string, agent: TokenRingAgent) => {
      const handle = this.getManagedTerminal(sessionId, agent);
      if (!handle) {
        return originalRetrieveSessionOutput(sessionId, agent);
      }

      const output = await handle.handle.currentOutput();
      const terminalState = this.getTerminalState(agent);
      const sessionRecord = terminalState.getSession(sessionId);
      if (!sessionRecord) {
        throw new Error(`Session ${sessionId} not found`);
      }

      let fromPosition = sessionRecord.lastPosition;
      if (output.truncated && fromPosition > output.output.length) {
        fromPosition = 0;
      }

      let incrementalOutput = output.output.substring(fromPosition);
      if (output.truncated && fromPosition === 0) {
        incrementalOutput = `${incrementalOutput}\n[...Terminal output truncated by ACP client...]\n`;
      }

      const newPosition = output.output.length;
      terminalState.updateSessionPosition(sessionId, newPosition);
      const updatedSession = terminalState.getSession(sessionId);
      if (updatedSession && output.exitStatus) {
        updatedSession.running = false;
      }

      if (incrementalOutput.length > terminalState.bash.cropOutput) {
        incrementalOutput =
          `${incrementalOutput.substring(0, terminalState.bash.cropOutput)}\n[...Output truncated...]\n`;
      }

      return {
        output: incrementalOutput,
        position: newPosition,
        complete: Boolean(output.exitStatus),
      };
    };

    terminalService.getCompleteSessionOutput = async (sessionId: string, agent: TokenRingAgent) => {
      const handle = this.getManagedTerminal(sessionId, agent);
      if (!handle) {
        return originalGetCompleteSessionOutput(sessionId, agent);
      }

      const output = await handle.handle.currentOutput();
      return output.truncated
        ? `${output.output}\n[...Terminal output truncated by ACP client...]\n`
        : output.output;
    };
  }

  private getSessionForAgent(agent: TokenRingAgent): ACPSession | null {
    return this.sessionsByAgentId.get(agent.id) ?? null;
  }

  private getACPFileReadSession(agent: TokenRingAgent): ACPSession | null {
    return this.connection && this.clientCapabilities.fs?.readTextFile
      ? this.getSessionForAgent(agent)
      : null;
  }

  private getACPFileWriteSession(agent: TokenRingAgent): ACPSession | null {
    return this.connection && this.clientCapabilities.fs?.writeTextFile
      ? this.getSessionForAgent(agent)
      : null;
  }

  private getACPFileReadWriteSession(agent: TokenRingAgent): ACPSession | null {
    return this.connection
      && this.clientCapabilities.fs?.readTextFile
      && this.clientCapabilities.fs?.writeTextFile
      ? this.getSessionForAgent(agent)
      : null;
  }

  private getACPTerminalSession(agent: TokenRingAgent): ACPSession | null {
    return this.connection && this.clientCapabilities.terminal
      ? this.getSessionForAgent(agent)
      : null;
  }

  private getServiceByName<T extends TokenRingService>(name: string): T | null {
    return this.app.getServices().find((service) => service.name === name) as T | undefined ?? null;
  }

  private requireStateByName<T>(agent: TokenRingAgent, stateName: string): T {
    for (const slice of agent.stateManager.slices()) {
      if (slice.name === stateName) {
        return slice as T;
      }
    }

    throw new Error(`State slice ${stateName} not found`);
  }

  private getFileSystemState(agent: TokenRingAgent): FileSystemStateLike {
    return this.requireStateByName<FileSystemStateLike>(agent, "FileSystemState");
  }

  private getTerminalState(agent: TokenRingAgent): TerminalStateLike {
    return this.requireStateByName<TerminalStateLike>(agent, "TerminalState");
  }

  private resolveACPAbsoluteFilePath(filePath: string, agent: TokenRingAgent): string {
    const workingDirectory = this.getFileSystemState(agent).workingDirectory;
    const absolutePath = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(workingDirectory, filePath);
    const relativePath = path.relative(workingDirectory, absolutePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Path ${filePath} is outside the root directory`);
    }

    return absolutePath;
  }

  private resolveACPTerminalWorkingDirectory(
    agent: TokenRingAgent,
    workingDirectory?: string,
  ): string {
    const agentWorkingDirectory = this.getTerminalState(agent).workingDirectory;
    if (!workingDirectory) {
      return agentWorkingDirectory;
    }

    return path.isAbsolute(workingDirectory)
      ? path.normalize(workingDirectory)
      : path.resolve(agentWorkingDirectory, workingDirectory);
  }

  private async runACPCommand(
    session: ACPSession,
    agent: TokenRingAgent,
    command: string,
    args: string[],
    options: Partial<ExecuteCommandOptions>,
  ): Promise<ExecuteCommandResult> {
    const handle = await this.connection!.createTerminal({
      sessionId: session.sessionId,
      command,
      ...(args.length > 0 && {args}),
      cwd: this.resolveACPTerminalWorkingDirectory(agent, options.workingDirectory),
      ...(options.env && {
        env: Object.entries(options.env)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => ({name, value: value!})),
      }),
    });

    try {
      const timeoutSeconds = options.timeoutSeconds ?? 120;
      const exitResult = await Promise.race([
        handle.waitForExit().then((result) => ({type: "exit" as const, result})),
        delay(timeoutSeconds * 1000).then(() => ({type: "timeout" as const})),
      ]);

      if (exitResult.type === "timeout") {
        await handle.kill().catch(() => undefined);
        return {status: "timeout"};
      }

      const output = await handle.currentOutput();
      const formattedOutput = output.truncated
        ? `${output.output}\n[...Terminal output truncated by ACP client...]\n`
        : output.output;
      const exitCode = exitResult.result.exitCode ?? output.exitStatus?.exitCode ?? 1;

      if (exitCode === 0 && !exitResult.result.signal) {
        return {
          status: "success",
          output: formattedOutput,
          exitCode: 0,
        };
      }

      return {
        status: "badExitCode",
        output: formattedOutput,
        exitCode,
      };
    } catch (error) {
      return {
        status: "unknownError",
        error: (error as Error).message,
      };
    } finally {
      await handle.release().catch(() => undefined);
    }
  }

  private getManagedTerminal(sessionId: string, agent: TokenRingAgent): ACPManagedTerminal | null {
    const handle = this.terminalHandles.get(sessionId);
    if (!handle || handle.agentId !== agent.id) {
      return null;
    }
    return handle;
  }

  private async releaseManagedTerminal(
    terminal: ACPManagedTerminal,
    agent?: TokenRingAgent,
  ): Promise<void> {
    this.terminalHandles.delete(terminal.terminalId);
    await terminal.handle.release().catch(() => undefined);
    if (agent) {
      this.getTerminalState(agent).removeSession(terminal.terminalId);
    }
  }

  private async cleanupSessions(reason: string): Promise<void> {
    const agentManager = this.app.getService(AgentManager);

    await Promise.allSettled(
      Array.from(this.terminalHandles.values()).map((terminal) => terminal.handle.release()),
    );
    this.terminalHandles.clear();

    if (!agentManager) {
      this.sessions.clear();
      this.sessionsByAgentId.clear();
      return;
    }

    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    this.sessionsByAgentId.clear();

    await Promise.allSettled(
      sessions.map(async (session) => {
        await agentManager.deleteAgent(session.agent.id, reason);
      }),
    );
  }
}

class TokenRingACPAgent implements ACPAgent {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly service: ACPService,
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return this.service.initialize(params);
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.service.createSession(params);
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.service.listSessions(params);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.service.prompt(this.connection, params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.service.cancel(params);
  }
}

function convertPromptToAgentInput(prompt: ContentBlock[]): {
  message: string;
  attachments: InputAttachment[];
} {
  const textParts: string[] = [];
  const attachments: InputAttachment[] = [];

  for (const block of prompt) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        break;
      case "resource_link":
        attachments.push({
          type: "attachment",
          name: block.title || block.name,
          encoding: "href",
          mimeType: block.mimeType || "application/octet-stream",
          body: block.uri,
          timestamp: Date.now(),
        });
        break;
      case "resource":
        attachments.push(convertEmbeddedResourceToAttachment(block));
        break;
      case "image":
        attachments.push({
          type: "attachment",
          name: getAttachmentName(block.uri, "image"),
          encoding: "base64",
          mimeType: block.mimeType,
          body: block.data,
          timestamp: Date.now(),
        });
        break;
      case "audio":
        attachments.push({
          type: "attachment",
          name: getAttachmentName(undefined, "audio"),
          encoding: "base64",
          mimeType: block.mimeType,
          body: block.data,
          timestamp: Date.now(),
        });
        break;
      default:
        block satisfies never;
        break;
    }
  }

  const message = textParts.join("\n\n").trim() || "Use the attached context to help with this request.";
  return {message, attachments};
}

function convertEmbeddedResourceToAttachment(block: EmbeddedResource): InputAttachment {
  const resource = block.resource;
  if ("text" in resource) {
    return {
      type: "attachment",
      name: getAttachmentName(resource.uri, "resource.txt"),
      encoding: "text",
      mimeType: resource.mimeType || "text/plain",
      body: resource.text,
      timestamp: Date.now(),
    };
  }

  return {
    type: "attachment",
    name: getAttachmentName(resource.uri, "resource.bin"),
    encoding: "base64",
    mimeType: resource.mimeType || "application/octet-stream",
    body: resource.blob,
    timestamp: Date.now(),
  };
}

function convertArtifactToContentBlock(event: Extract<AgentEventEnvelope, {type: "output.artifact"}>): ContentBlock {
  const uri = `artifact://${encodeURIComponent(event.name)}`;
  if (event.encoding === "text") {
    return {
      type: "resource",
      resource: {
        uri,
        mimeType: event.mimeType,
        text: event.body,
      },
    };
  }

  return {
    type: "resource",
    resource: {
      uri,
      mimeType: event.mimeType,
      blob: event.body,
    },
  };
}

function getAttachmentName(uri: string | null | undefined, fallback: string): string {
  if (!uri) {
    return fallback;
  }

  try {
    const url = new URL(uri);
    const lastPathComponent = url.pathname.split("/").filter(Boolean).pop();
    return lastPathComponent || fallback;
  } catch {
    return uri.split("/").filter(Boolean).pop() || fallback;
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), {once: true});
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? {...(value as Record<string, unknown>)}
    : {};
}

function toACPTextContent(content: string | Buffer): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Buffer.isBuffer(content)) {
    return content.toString("utf-8");
  }

  return null;
}
