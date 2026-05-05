import { Agent } from "../agents/agent.entity";
import { Task } from "../tasks/task.entity";
import { CodexExecutionContext, CodexRunResult } from "./codex-runner";
import { OrchestratorService } from "./orchestrator.service";

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "auto-1",
    source: "meegle",
    externalId: "MEEGLE-1",
    title: "Task",
    description: null,
    repo: "demo/repo",
    branch: "main",
    taskType: "feature",
    priority: "medium",
    status: "queued",
    instruction: "Run Codex",
    constraints: [],
    retryCount: 0,
    claimedAt: null,
    startedAt: null,
    completedAt: null,
    agentId: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides
  }) as Task;

const createAgent = (overrides: Partial<Agent> = {}): Agent =>
  ({
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
  }) as Agent;

describe("OrchestratorService", () => {
  it("schedules higher priority tasks before older lower priority tasks", async () => {
    const low = createTask({
      id: "low",
      priority: "low",
      createdAt: new Date("2026-05-01T00:00:00.000Z")
    });
    const high = createTask({
      id: "high",
      priority: "high",
      createdAt: new Date("2026-05-02T00:00:00.000Z")
    });
    const agent = createAgent();
    const taskService = createTaskService([low, high]);
    const agentService = createAgentService([agent]);
    const runner = createRunner({ exitCode: 0, stdout: "ok", stderr: "" });
    const executionLogService = createExecutionLogService();
    const service = new OrchestratorService(
      taskService as never,
      agentService as never,
      executionLogService as never,
      runner as never,
      createResultReporter() as never
    );

    await service.poll();

    expect(taskService.claim).toHaveBeenCalledWith("high", "agent-1");
  });

  it("fails pending tasks that are missing execution fields", async () => {
    const invalid = createTask({ id: "invalid", status: "pending", instruction: "" });
    const taskService = createTaskService([invalid]);
    const agentService = createAgentService([createAgent()]);
    const runner = createRunner({ exitCode: 0, stdout: "ok", stderr: "" });
    const executionLogService = createExecutionLogService();
    const service = new OrchestratorService(
      taskService as never,
      agentService as never,
      executionLogService as never,
      runner as never,
      createResultReporter() as never
    );

    await service.poll();

    expect(taskService.markFailedInternal).toHaveBeenCalledWith(
      "invalid",
      "Task execution fields are invalid",
      expect.objectContaining({ missingFields: ["instruction"] })
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("marks task done and releases agent when Codex exits successfully", async () => {
    const task = createTask({ id: "auto-1", status: "queued" });
    const agent = createAgent({ id: "agent-1" });
    const taskService = createTaskService([task]);
    const agentService = createAgentService([agent]);
    const runner = createRunner({ exitCode: 0, stdout: "ok", stderr: "" });
    const reporter = createResultReporter();
    const executionLogService = createExecutionLogService();
    const service = new OrchestratorService(
      taskService as never,
      agentService as never,
      executionLogService as never,
      runner as never,
      reporter as never
    );

    await service.poll();

    expect(executionLogService.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        taskId: "auto-1",
        agentId: "agent-1",
        status: "running",
        message: "Preparing project workspace for branch checkout and Codex execution",
        metadata: expect.objectContaining({
          repo: "demo/repo",
          branch: "main",
          hostCwd: expect.stringContaining("/demo/repo"),
          containerCwd: "/workspace/demo/repo"
        })
      })
    );
    expect(executionLogService.append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        taskId: "auto-1",
        agentId: "agent-1",
        status: "running",
        message: "Codex exited normally",
        metadata: expect.objectContaining({
          stage: "codex",
          exitCode: 0,
          normalExit: true,
          branchCheckedOut: true,
          codexStarted: true
        })
      })
    );
    expect(taskService.markDoneInternal).toHaveBeenCalledWith("auto-1", {
      repo: "demo/repo",
      branch: "main",
      hostCwd: expect.stringContaining("/demo/repo"),
      containerCwd: "/workspace/demo/repo",
      stage: "codex",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: true,
      normalExit: true
    });
    expect(reporter.reportSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "auto-1" }),
      expect.objectContaining({ stdout: "ok", stderr: "", exitCode: 0 })
    );
    expect(agentService.markIdle).toHaveBeenCalledWith("agent-1");
  });

  it("marks task failed and releases agent when Codex exits with error", async () => {
    const task = createTask({ id: "auto-1", status: "queued" });
    const agent = createAgent({ id: "agent-1" });
    const taskService = createTaskService([task]);
    const agentService = createAgentService([agent]);
    const runner = createRunner({ exitCode: 1, stdout: "out", stderr: "boom" });
    const reporter = createResultReporter();
    const executionLogService = createExecutionLogService();
    const service = new OrchestratorService(
      taskService as never,
      agentService as never,
      executionLogService as never,
      runner as never,
      reporter as never
    );

    await service.poll();

    expect(taskService.markFailedInternal).toHaveBeenCalledWith("auto-1", "Codex exited abnormally", {
      repo: "demo/repo",
      branch: "main",
      hostCwd: expect.stringContaining("/demo/repo"),
      containerCwd: "/workspace/demo/repo",
      stage: "codex",
      stdout: "out",
      stderr: "boom",
      exitCode: 1,
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: true,
      normalExit: false
    });
    expect(reporter.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "auto-1" }),
      expect.objectContaining({ stdout: "out", stderr: "boom", exitCode: 1 })
    );
    expect(agentService.markIdle).toHaveBeenCalledWith("agent-1");
  });

  it("marks task failed when branch checkout fails inside the project directory", async () => {
    const task = createTask({ id: "auto-1", status: "queued" });
    const agent = createAgent({ id: "agent-1" });
    const taskService = createTaskService([task]);
    const agentService = createAgentService([agent]);
    const runner = createRunner({
      stage: "checkout",
      exitCode: 128,
      stdout: "",
      stderr: "pathspec did not match",
      timedOut: false,
      branchCheckedOut: false,
      codexStarted: false
    });
    const executionLogService = createExecutionLogService();
    const service = new OrchestratorService(
      taskService as never,
      agentService as never,
      executionLogService as never,
      runner as never,
      createResultReporter() as never
    );

    await service.poll();

    expect(taskService.markFailedInternal).toHaveBeenCalledWith(
      "auto-1",
      "Branch checkout failed in project directory",
      expect.objectContaining({
        stage: "checkout",
        exitCode: 128,
        branchCheckedOut: false,
        codexStarted: false,
        containerCwd: "/workspace/demo/repo"
      })
    );
  });

  it("releases agent even when result reporting fails", async () => {
    const task = createTask({ id: "auto-1", status: "queued" });
    const agent = createAgent({ id: "agent-1" });
    const taskService = createTaskService([task]);
    const agentService = createAgentService([agent]);
    const runner = createRunner({ exitCode: 0, stdout: "ok", stderr: "" });
    const reporter = {
      reportSuccess: jest.fn(async () => {
        throw new Error("comment failed");
      }),
      reportFailure: jest.fn(async () => undefined)
    };
    const executionLogService = createExecutionLogService();
    const service = new OrchestratorService(
      taskService as never,
      agentService as never,
      executionLogService as never,
      runner as never,
      reporter as never
    );

    await service.poll();

    expect(taskService.markDoneInternal).toHaveBeenCalled();
    expect(agentService.markIdle).toHaveBeenCalledWith("agent-1");
  });

  it("refreshes heartbeat before and after Codex execution", async () => {
    const task = createTask({ id: "auto-1", status: "queued" });
    const agent = createAgent({ id: "agent-1" });
    const taskService = createTaskService([task]);
    const agentService = createAgentService([agent]);
    const runner = createRunner({ exitCode: 0, stdout: "ok", stderr: "" });
    const executionLogService = createExecutionLogService();
    const service = new OrchestratorService(
      taskService as never,
      agentService as never,
      executionLogService as never,
      runner as never,
      createResultReporter() as never
    );

    await service.poll();

    expect(agentService.refreshHeartbeat).toHaveBeenCalledWith("agent-1");
    expect(agentService.refreshHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("skips overlapping poll while a previous poll is still running", async () => {
    let resolveRun: (value: CodexRunResult) => void = () => undefined;
    let markRunStarted: () => void = () => undefined;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const task = createTask({ id: "auto-1", status: "queued" });
    const agent = createAgent({ id: "agent-1" });
    const taskService = createTaskService([task]);
    const agentService = createAgentService([agent]);
    const runner = {
      getExecutionContext: jest.fn(
        (task: Task): CodexExecutionContext => ({
          repo: task.repo,
          branch: task.branch,
          hostCwd: `${process.cwd()}/${task.repo}`,
          containerCwd: `/workspace/${task.repo}`,
          cloneUrl: null,
          isAbsolutePath: false
        })
      ),
      run: jest.fn(
        () => {
          markRunStarted();
          return (
          new Promise<CodexRunResult>((resolve) => {
            resolveRun = resolve;
          })
          );
        }
      )
    };
    const service = new OrchestratorService(
      taskService as never,
      agentService as never,
      createExecutionLogService() as never,
      runner as never,
      createResultReporter() as never
    );

    const firstPoll = service.poll();
    await runStarted;
    await service.poll();
    resolveRun({
      stage: "codex",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: true,
      repo: task.repo,
      branch: task.branch,
      hostCwd: `${process.cwd()}/${task.repo}`,
      containerCwd: `/workspace/${task.repo}`
    });
    await firstPoll;

    expect(agentService.detectOfflineAgents).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("releases claimed agent when task claim fails", async () => {
    const task = createTask({ id: "auto-1", status: "queued" });
    const agent = createAgent({ id: "agent-1" });
    const taskService = createTaskService([task]);
    taskService.claim.mockRejectedValueOnce(new Error("stale task state"));
    const agentService = createAgentService([agent]);
    const runner = createRunner({ exitCode: 0, stdout: "ok", stderr: "" });
    const service = new OrchestratorService(
      taskService as never,
      agentService as never,
      createExecutionLogService() as never,
      runner as never,
      createResultReporter() as never
    );

    await service.poll();

    expect(agentService.markIdle).toHaveBeenCalledWith("agent-1");
    expect(runner.run).not.toHaveBeenCalled();
  });
});

function createTaskService(tasks: Task[]) {
  return {
    listTasks: jest.fn(async () => tasks),
    enqueue: jest.fn(async (id: string) => {
      const task = tasks.find((candidate) => candidate.id === id)!;
      task.status = "queued";
      return task;
    }),
    claim: jest.fn(async (id: string, agentId: string) => {
      const task = tasks.find((candidate) => candidate.id === id)!;
      task.status = "running";
      task.agentId = agentId;
      return task;
    }),
    markDoneInternal: jest.fn(async (id: string) => tasks.find((task) => task.id === id)!),
    markFailedInternal: jest.fn(async (id: string) => tasks.find((task) => task.id === id)!)
  };
}

function createAgentService(agents: Agent[]) {
  return {
    ensurePool: jest.fn(async () => undefined),
    detectOfflineAgents: jest.fn(async () => []),
    findIdleAgent: jest.fn(async () => {
      const agent = agents.find((candidate) => candidate.status === "idle") ?? null;
      if (agent) {
        agent.status = "running";
      }
      return agent;
    }),
    claimIdleAgent: jest.fn(async (taskId: string) => {
      const agent = agents.find((candidate) => candidate.status === "idle" && !candidate.taskId) ?? null;
      if (agent) {
        agent.status = "running";
        agent.taskId = taskId;
      }
      return agent;
    }),
    markRunning: jest.fn(async (agentId: string, taskId: string) => {
      const agent = agents.find((candidate) => candidate.id === agentId)!;
      agent.status = "running";
      agent.taskId = taskId;
      return agent;
    }),
    markIdle: jest.fn(async (agentId: string) => {
      const agent = agents.find((candidate) => candidate.id === agentId)!;
      agent.status = "idle";
      agent.taskId = null;
      return agent;
    }),
    refreshHeartbeat: jest.fn(async (agentId: string) => agents.find((candidate) => candidate.id === agentId)!)
  };
}

function createExecutionLogService() {
  return {
    append: jest.fn(async () => undefined)
  };
}

function createRunner(
  result: Partial<CodexRunResult> & Pick<CodexRunResult, "exitCode" | "stdout" | "stderr">
) {
  return {
    getExecutionContext: jest.fn(
      (task: Task): CodexExecutionContext => ({
        repo: task.repo,
        branch: task.branch,
        hostCwd: `${process.cwd()}/${task.repo}`,
        containerCwd: `/workspace/${task.repo}`,
        cloneUrl: null,
        isAbsolutePath: false
      })
    ),
    run: jest.fn(async (task: Task) => ({
      stage: "codex",
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: true,
      repo: task.repo,
      branch: task.branch,
      hostCwd: `${process.cwd()}/${task.repo}`,
      containerCwd: `/workspace/${task.repo}`,
      ...result
    }))
  };
}

function createResultReporter() {
  return {
    reportSuccess: jest.fn(async () => undefined),
    reportFailure: jest.fn(async () => undefined)
  };
}
