import type {AgentSideConnection} from "@agentclientprotocol/sdk";
import type {
  ExecuteCommandOptions,
  ExecuteCommandResult,
  NonInteractiveTerminalProvider,
  TerminalIsolationLevel,
} from "@tokenring-ai/terminal/TerminalProvider";
import process from "node:process";
import {setTimeout as delay} from "node:timers/promises";

export default class ACPTerminalProvider
  implements NonInteractiveTerminalProvider {
  readonly isInteractive = false;
  readonly name = "ACPTerminalProvider";
  readonly displayName: string;
  readonly supportedIsolationLevels: TerminalIsolationLevel[] = ["none"];

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
  ) {
    this.displayName = `ACP Terminal (session: ${sessionId})`;
  }

  async executeCommand(
    command: string,
    args: string[],
    options: ExecuteCommandOptions,
  ): Promise<ExecuteCommandResult> {
    const handle = await this.connection.createTerminal({
      sessionId: this.sessionId,
      command,
      ...(args.length > 0 && {args}),
      cwd: options.workingDirectory,
    });

    try {
      const timeoutSeconds = options.timeoutSeconds ?? 120;
      const exitResult = await Promise.race([
        handle
          .waitForExit()
          .then((result) => ({type: "exit" as const, result})),
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
      const exitCode =
        exitResult.result.exitCode ?? output.exitStatus?.exitCode ?? 1;

      if (exitCode === 0 && !exitResult.result.signal) {
        return {status: "success", output: formattedOutput, exitCode: 0};
      }

      return {status: "badExitCode", output: formattedOutput, exitCode};
    } catch (error: unknown) {
      return {status: "unknownError", error: (error as Error).message};
    } finally {
      await handle.release().catch(() => undefined);
    }
  }

  runScript(
    script: string,
    options: ExecuteCommandOptions,
  ): Promise<ExecuteCommandResult> {
    const shell = process.env.SHELL || "/bin/bash";
    return this.executeCommand(shell, ["-lc", script], options);
  }
}
