import {
  type Agent as ACPAgent,
  type AgentCapabilities,
  AgentSideConnection,
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
  ndJsonStream,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  PROTOCOL_VERSION,
  RequestError,
  type SessionInfo,
} from "@agentclientprotocol/sdk";
import type TokenRingAgent from "@tokenring-ai/agent/Agent";
import type {AgentEventEnvelope, InputAttachment} from "@tokenring-ai/agent/AgentEvents";
import type {ParsedAgentConfig} from "@tokenring-ai/agent/schema";
import AgentManager from "@tokenring-ai/agent/services/AgentManager";
import {AgentEventState} from "@tokenring-ai/agent/state/agentEventState";
import TokenRingApp from "@tokenring-ai/app";
import type {TokenRingService} from "@tokenring-ai/app/types";
import FileSystemService from "@tokenring-ai/filesystem/FileSystemService";
import TerminalService from "@tokenring-ai/terminal/TerminalService";
import {randomUUID} from "node:crypto";
import path from "node:path";
import process from "node:process";
import {Readable, Writable} from "node:stream";
import ACPFileSystemProvider from "./ACPFileSystemProvider.ts";
import ACPTerminalProvider from "./ACPTerminalProvider.ts";
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
  fileSystemProviderName?: string;
  terminalProvider?: ACPTerminalProvider;
  terminalProviderName?: string;
};

type StreamMessageIds = {
  assistant: string;
  thought: string;
};

type ACPAgentConfig = ParsedAgentConfig & {
  filesystem?: Record<string, unknown>;
  terminal?: Record<string, unknown>;
};

export default class ACPService implements TokenRingService {
  readonly name = "ACPService";
  description = "ACP (Agent Client Protocol) server for TokenRing agents";

  private connection: AgentSideConnection | null = null;
  private clientCapabilities: ClientCapabilities = {};
  private readonly sessions = new Map<string, ACPSession>();
  private readonly sessionsByAgentId = new Map<string, ACPSession>();

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
    this.configureSessionProviders(session);
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

  private configureSessionProviders(session: ACPSession): void {
    if (!this.connection) {
      return;
    }

    const fileSystemService = this.app.getService(FileSystemService);
    if (fileSystemService && (this.clientCapabilities.fs?.readTextFile || this.clientCapabilities.fs?.writeTextFile)) {
      const providerName = `acp-fs-${session.sessionId}`;
      fileSystemService.registerFileSystemProvider(
        providerName,
        new ACPFileSystemProvider(this.connection, session.sessionId, this.clientCapabilities),
      );
      fileSystemService.setActiveFileSystem(providerName, session.agent);
      session.fileSystemProviderName = providerName;
    }

    const terminalService = this.app.getService(TerminalService);
    if (terminalService && this.clientCapabilities.terminal) {
      const providerName = `acp-terminal-${session.sessionId}`;
      const provider = new ACPTerminalProvider(this.connection, session.sessionId);
      terminalService.registerTerminalProvider(providerName, provider);
      terminalService.setActiveProvider(providerName, session.agent);
      session.terminalProvider = provider;
      session.terminalProviderName = providerName;
    }
  }

  private validateSessionCwd(cwd: string): string {
    if (!path.isAbsolute(cwd)) {
      throw RequestError.invalidParams({cwd}, "ACP session cwd must be an absolute path");
    }

    return path.resolve(cwd);
  }

  private async cleanupSessions(reason: string): Promise<void> {
    const agentManager = this.app.getService(AgentManager);
    const fileSystemService = this.app.getService(FileSystemService);
    const terminalService = this.app.getService(TerminalService);

    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    this.sessionsByAgentId.clear();

    await Promise.allSettled(
      sessions.map(async (session) => {
        if (session.fileSystemProviderName) {
          fileSystemService?.unregisterFileSystemProvider(session.fileSystemProviderName);
        }
        if (session.terminalProviderName) {
          terminalService?.unregisterTerminalProvider(session.terminalProviderName);
        }

        if (agentManager) {
          agentManager.deleteAgent(session.agent.id, reason);
        }
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
