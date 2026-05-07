import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigService } from "@nestjs/config";
import { Agent } from "../../../packages/core/src/agents/agent.entity";
import { ExecutionLogService } from "../../../packages/core/src/execution-logs/execution-log.service";
import { RuntimeCommand } from "../../../packages/core/src/plugins/agent-runtime.plugin";
import { Task } from "../../../packages/core/src/tasks/task.entity";
import { CodexRunner } from "./codex-runner";

describe("CodexRunner", () => {
  it("appends streaming stdout and stderr logs during workflow execution", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runner-workspace-"));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runner-repo-"));
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

    const task = createTask({ repo: repoRoot });
    const agent = createAgent();
    const append = jest.fn(async () => undefined);
    const runtime = {
      runtime: "local",
      ensureRuntime: jest.fn(async () => ({ containerId: "local:agent-1", running: true })),
      runCommand: jest.fn(async (_agent: Agent, command: RuntimeCommand) => {
        if (command.command === "git" && command.args[0] === "worktree" && command.args[1] === "add") {
          fs.mkdirSync(path.join(worktreeRoot, "knowledge"), { recursive: true });
          fs.writeFileSync(path.join(worktreeRoot, "AGENTS.md"), "# Agents\n");
          fs.writeFileSync(
            path.join(worktreeRoot, "knowledge", "WORKFLOW_PROMPTS.md"),
            [
              "## Agents 默认执行流程",
              "- `Implement`",
              "",
              "### Implement",
              "- `loopEnabled: false`",
              "- `maxLoops: 1`",
              "```text",
              "Implement {{taskPrompt}}",
              "```"
            ].join("\n")
          );
          return { stdout: "", stderr: "" };
        }

        if (command.command === "git") {
          return { stdout: "", stderr: "" };
        }

        if (command.command === "sh") {
          return { stdout: "", stderr: "" };
        }

        await command.onStdoutChunk?.("plan started\n");
        await command.onStderrChunk?.("warning found\n");
        return { stdout: "plan started\n", stderr: "warning found\n" };
      })
    };
    const configService = new ConfigService({
      CODEX_WORKDIR: workspaceRoot,
      CODEX_CLI_BIN: "codex",
      CODEX_TIMEOUT_MS: "5000"
    });
    const runner = new CodexRunner(
      configService,
      runtime as never,
      { append, listByTask: jest.fn() } as unknown as ExecutionLogService
    );
    const worktreeRoot = runner.getExecutionContext(task).worktreePath;

    const result = await runner.runTask(task, agent);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("plan started");
    expect(result.stderr).toContain("warning found");
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        agentId: agent.id,
        status: "running",
        message: "stdout chunk from workflow node Implement",
        metadata: expect.objectContaining({
          node: "Implement",
          stream: "stdout",
          stdout: "plan started\n"
        })
      })
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        agentId: agent.id,
        status: "running",
        message: "stderr chunk from workflow node Implement",
        metadata: expect.objectContaining({
          node: "Implement",
          stream: "stderr",
          stderr: "warning found\n"
        })
      })
    );

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "auto-1",
    source: "meegle",
    externalId: "MEEGLE-1",
    title: "Stream logs",
    description: null,
    repo: "/tmp/repo",
    branch: "main",
    taskType: "feature",
    priority: "medium",
    status: "queued",
    instruction: "stream output",
    constraints: [],
    retryCount: 0,
    claimedAt: null,
    startedAt: null,
    completedAt: null,
    agentId: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides
  } as Task;
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    taskId: null,
    containerId: null,
    containerName: "agent-1",
    status: "idle",
    startedAt: null,
    heartbeatAt: new Date("2026-05-01T00:00:00.000Z"),
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides
  } as Agent;
}
