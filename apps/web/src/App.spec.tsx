import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

class MockEventSource {
  static instances: MockEventSource[] = [];

  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }

  close() {}
}

describe("App", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/dashboard")) {
        return jsonResponse({
          tasks: { total: 2, byStatus: { queued: 1, failed: 1 } },
          agents: { total: 0, byStatus: {} },
          plugins: { total: 1, healthy: 0 }
        });
      }
      if (url.endsWith("/tasks")) {
        return jsonResponse([
          {
            id: "task-1",
            title: "Fix build",
            repo: "repo-a",
            branch: "main",
            executor: "codex",
            status: "queued",
            priority: "high",
            traceId: "trace-1",
            repairCount: 0,
            retryCount: 0,
            createdAt: "2026-05-11T00:00:00.000Z"
          },
          {
            id: "task-2",
            title: "Repair tests",
            repo: "repo-b",
            branch: "dev",
            executor: "codex",
            status: "failed",
            priority: "medium",
            traceId: "trace-2",
            repairCount: 1,
            retryCount: 2,
            createdAt: "2026-05-11T00:00:00.000Z"
          }
        ]);
      }
      if (url.endsWith("/agents")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/plugins")) {
        return jsonResponse([
          {
            id: "meegle",
            kind: "task-integration",
            priority: 10,
            capabilities: ["meegle"],
            health: {
              healthy: false,
              message: "credentials missing"
            }
          }
        ]);
      }
      if (url.endsWith("/plugin-configs")) {
        return jsonResponse([
          {
            pluginId: "meegle",
            kind: "task-integration",
            enabled: true,
            priority: 30,
            config: { mode: "poll" }
          }
        ]);
      }
      if (url.endsWith("/readiness")) {
        return jsonResponse({
          ok: false,
          status: "degraded",
          checks: {
            plugins: {
              ok: false,
              message: "One or more required plugin kinds are unhealthy",
              requiredKinds: {
                environment: true,
                execution: true,
                quality: true,
                "observability-governance": true,
                "task-integration": false
              }
            }
          }
        });
      }
      if (url.endsWith("/tasks/task-1/executions") || url.endsWith("/tasks/task-2/executions")) {
        return jsonResponse([
          {
            id: "exec-1",
            status: "failed",
            summary: "timed out",
            executor: "codex",
            startedAt: "2026-05-11T00:00:00.000Z",
            endedAt: "2026-05-11T00:05:00.000Z",
            agentId: "agent-1"
          }
        ]);
      }
      if (url.endsWith("/tasks/task-1/transitions")) {
        return jsonResponse([
          {
            taskId: "task-1",
            traceId: "trace-1",
            from: "queued",
            to: "running",
            reason: "claimed",
            operator: "scheduler",
            timestamp: "2026-05-11T00:00:00.000Z"
          }
        ]);
      }
      if (url.endsWith("/tasks/task-2/transitions")) {
        return jsonResponse([
          {
            taskId: "task-2",
            traceId: "trace-2",
            from: "running",
            to: "blocked",
            reason: "timeout budget exhausted",
            operator: "scheduler",
            timestamp: "2026-05-11T00:05:00.000Z"
          }
        ]);
      }
      if (url.endsWith("/tasks/task-1/logs")) {
        return jsonResponse([
          {
            id: "log-1",
            taskId: "task-1",
            executionId: "exec-1",
            eventType: "execution.retry_scheduled",
            message: "Execution failure scheduled for retry",
            data: { attempt: 1, retryLimit: 2, errorCategory: "timeout", timeoutCategory: "execution_timeout" },
            createdAt: "2026-05-11T00:05:00.000Z"
          }
        ]);
      }
      if (url.endsWith("/tasks/task-2/logs")) {
        return jsonResponse([
          {
            id: "log-2",
            taskId: "task-2",
            executionId: "exec-1",
            eventType: "execution.blocked",
            message: "Execution failure blocked task",
            data: { attempt: 3, retryLimit: 2, errorCategory: "timeout", timeoutCategory: "execution_timeout" },
            createdAt: "2026-05-11T00:05:00.000Z"
          }
        ]);
      }
      if (url.endsWith("/tasks/task-1/eval-results")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/tasks/task-2/eval-results")) {
        return jsonResponse([
          {
            id: "eval-1",
            taskId: "task-2",
            executionId: "exec-1",
            passed: false,
            score: 35,
            riskLevel: "medium",
            report: {},
            createdAt: "2026-05-11T00:05:00.000Z"
          }
        ]);
      }
      if (url.endsWith("/tasks/task-1/repair-goal") || url.endsWith("/tasks/task-2/repair-goal")) {
        return jsonResponse(null);
      }
      if (url.endsWith("/tasks/task-1/observability") || url.endsWith("/tasks/task-2/observability")) {
        const taskId = url.includes("task-1") ? "task-1" : "task-2";
        return jsonResponse({
          schemaVersion: "2026-05-11",
          taskId,
          transitions: [],
          executionLogs: taskId === "task-1"
            ? [{
                id: "log-1",
                taskId,
                executionId: "exec-1",
                eventType: "execution.retry_scheduled",
                message: "Execution failure scheduled for retry",
                data: { attempt: 1, retryLimit: 2, errorCategory: "timeout", timeoutCategory: "execution_timeout" },
                createdAt: "2026-05-11T00:05:00.000Z"
              }]
            : [{
                id: "log-2",
                taskId,
                executionId: "exec-1",
                eventType: "execution.blocked",
                message: "Execution failure blocked task",
                data: { attempt: 3, retryLimit: 2, errorCategory: "timeout", timeoutCategory: "execution_timeout" },
                createdAt: "2026-05-11T00:05:00.000Z"
              }]
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
  });

  afterEach(() => {
    cleanup();
    MockEventSource.instances = [];
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("filters task list by search query and status pills", async () => {
    render(<App />);

    await screen.findByText("Fix build");
    expect(screen.getAllByText("Repair tests").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "repo-b" } });

    await waitFor(() => {
      expect(screen.queryByText("Fix build")).toBeNull();
    });
    expect(screen.getAllByText("Repair tests").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "" } });
    const filterBar = screen.getByRole("tablist", { name: "Task status filters" });
    const failedFilter = Array.from(filterBar.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("failed")
    );
    if (!failedFilter) {
      throw new Error("failed filter not found");
    }
    fireEvent.click(failedFilter);

    await waitFor(() => {
      expect(screen.queryByText("Fix build")).toBeNull();
    });
    expect(screen.getAllByText("Repair tests").length).toBeGreaterThan(0);
  });

  it("shows plugin health, config, and readiness details", async () => {
    render(<App />);

    await screen.findByText("credentials missing");
    expect(screen.getAllByText("meegle").length).toBeGreaterThan(0);
    expect(screen.getByText(/enabled true · priority 30/i)).not.toBeNull();
    expect(screen.getByText(/One or more required plugin kinds are unhealthy/i)).not.toBeNull();
    expect(screen.getByText(/"mode": "poll"/i)).not.toBeNull();
  });

  it("surfaces retry and block execution summaries in task detail", async () => {
    render(<App />);

    await screen.findByText("Fix build");
    await screen.findByText("Controller scheduled another automatic retry.");
    expect(screen.getAllByText(/attempt 1\/2/i).length).toBeGreaterThan(0);

    const failedFilter = Array.from(
      screen.getByRole("tablist", { name: "Task status filters" }).querySelectorAll("button")
    ).find((button) => button.textContent?.includes("failed"));
    if (!failedFilter) {
      throw new Error("failed filter not found");
    }
    fireEvent.click(failedFilter);

    await screen.findByText("Automatic retry stopped and the task was blocked.");
    expect(screen.getAllByText(/attempt 3\/2/i).length).toBeGreaterThan(0);
  });

  it("filters live events by category lens", async () => {
    render(<App />);

    await screen.findByText("Fix build");
    const source = MockEventSource.instances[0];
    source?.onmessage?.({
      data: JSON.stringify({
        id: "event-1",
        eventType: "scheduler.tick_started",
        traceId: "trace-1",
        taskId: "task-1",
        createdAt: "2026-05-11T00:06:00.000Z",
        data: {}
      })
    } as MessageEvent<string>);
    source?.onmessage?.({
      data: JSON.stringify({
        id: "event-2",
        eventType: "agent.offline",
        traceId: "trace-1",
        taskId: "task-1",
        createdAt: "2026-05-11T00:07:00.000Z",
        data: {}
      })
    } as MessageEvent<string>);

    await screen.findByText("scheduler / tick_started");
    const filterBar = screen.getByRole("tablist", { name: "Event category filters" });
    const schedulerFilter = Array.from(filterBar.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("scheduler")
    );
    if (!schedulerFilter) {
      throw new Error("scheduler filter not found");
    }
    fireEvent.click(schedulerFilter);

    await screen.findByText("scheduler / tick_started");
    expect(screen.queryByText("agent / offline")).toBeNull();
    expect(screen.queryByText("execution / retry_scheduled")).toBeNull();
  });

  it("shows reconnect banner and reconnects the live event stream", async () => {
    render(<App />);

    await screen.findByText("Fix build");
    expect(MockEventSource.instances.length).toBe(1);

    MockEventSource.instances[0]?.onerror?.();

    await screen.findByText("Live updates disconnected. Reconnecting in the background.");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }));

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(2);
    });
    await waitFor(() => {
      expect(screen.queryByText("Live updates disconnected. Reconnecting in the background.")).toBeNull();
    });
  });

  it("shows empty states when no runtime data has been synced", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/dashboard")) {
        return jsonResponse({
          tasks: { total: 0, byStatus: {} },
          agents: { total: 0, byStatus: {} },
          plugins: { total: 0, healthy: 0 }
        });
      }
      if (url.endsWith("/tasks")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/agents")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/plugins")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/plugin-configs")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/readiness")) {
        return jsonResponse({
          ok: true,
          status: "ready",
          checks: {
            plugins: {
              ok: true,
              message: "All required plugin kinds are healthy",
              requiredKinds: {}
            }
          }
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    render(<App />);

    await screen.findByText("No tasks have been synced yet.");
    expect(screen.getByText("No task selected.")).not.toBeNull();
    expect(screen.getByText("No agents registered.")).not.toBeNull();
    expect(screen.getByText("No plugins registered.")).not.toBeNull();
  });
});

function jsonResponse(data: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    json: async () => data
  } as Response);
}
