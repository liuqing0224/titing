import { spawn } from "node:child_process";
import { Injectable } from "@nestjs/common";
import {
  AgentRuntimePlugin,
  RuntimeCommand,
  RuntimeCommandResult
} from "../../../packages/core/src/plugins/agent-runtime.plugin";
import { Agent } from "../../../packages/core/src/agents/agent.entity";

@Injectable()
export class LocalAgentRuntimeService implements AgentRuntimePlugin {
  readonly runtime = "local";

  async ensureRuntime(agent: Agent): Promise<{ containerId: string; running: boolean }> {
    return {
      containerId: `local:${agent.id}`,
      running: true
    };
  }

  async runCommand(_agent: Agent, command: RuntimeCommand): Promise<RuntimeCommandResult> {
    const { stdout, stderr } = await this.execute(command);
    return { stdout, stderr };
  }

  private async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    return new Promise<RuntimeCommandResult>((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        cwd: command.options.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let pendingCallbacks = 0;
      let closeOutcome:
        | { kind: "success" }
        | { kind: "failure"; error: Error & Record<string, unknown> }
        | null = null;
      const maxBuffer = command.options.maxBuffer;
      const timeoutId =
        command.options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, command.options.timeout)
          : null;
      timeoutId?.unref?.();

      const finalize = (error?: Error & Record<string, unknown>): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          if (timedOut) {
            error.killed = true;
            error.signal = "SIGTERM";
          }
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      };

      const maybeFinalizeFromClose = (): void => {
        if (!closeOutcome || pendingCallbacks > 0) {
          return;
        }

        if (closeOutcome.kind === "success") {
          finalize();
          return;
        }

        finalize(closeOutcome.error);
      };

      const appendChunk = async (
        target: "stdout" | "stderr",
        chunk: Buffer,
        handler?: (chunk: string) => void | Promise<void>
      ): Promise<void> => {
        const text = chunk.toString();
        if (target === "stdout") {
          stdout += text;
        } else {
          stderr += text;
        }

        if (stdout.length + stderr.length > maxBuffer) {
          child.kill("SIGTERM");
          const overflowError = new Error(`Command output exceeded maxBuffer=${maxBuffer}`) as Error &
            Record<string, unknown>;
          overflowError.code = "MAX_BUFFER";
          finalize(overflowError);
          return;
        }

        if (handler) {
          pendingCallbacks += 1;
          try {
            await handler(text);
          } catch (error) {
            child.kill("SIGTERM");
            const callbackError =
              error instanceof Error
                ? (error as unknown as Error & Record<string, unknown>)
                : (new Error(String(error)) as Error & Record<string, unknown>);
            finalize(callbackError);
            return;
          } finally {
            pendingCallbacks -= 1;
            maybeFinalizeFromClose();
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        void appendChunk("stdout", chunk, command.onStdoutChunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        void appendChunk("stderr", chunk, command.onStderrChunk);
      });

      child.on("error", (error) => {
        finalize(error as Error & Record<string, unknown>);
      });

      child.on("close", (code, signal) => {
        if (code === 0 && !signal && !timedOut) {
          closeOutcome = { kind: "success" };
          maybeFinalizeFromClose();
          return;
        }

        const failure = new Error(
          timedOut ? "Command timed out" : `Command exited with code ${code ?? "unknown"}`
        ) as Error & Record<string, unknown>;
        failure.code = code ?? 1;
        failure.signal = signal ?? undefined;
        failure.killed = timedOut;
        closeOutcome = { kind: "failure", error: failure };
        maybeFinalizeFromClose();
      });
    });
  }
}
