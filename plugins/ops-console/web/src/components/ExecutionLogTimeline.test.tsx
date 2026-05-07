import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { ExecutionLogTimeline } from "./ExecutionLogTimeline";

describe("ExecutionLogTimeline", () => {
  it("shows parsed failure hint for Cursor auth errors", () => {
    render(
      <ExecutionLogTimeline
        logs={[
          {
            id: "log-1",
            taskId: "auto-1",
            agentId: "agent-1",
            status: "failed",
            message: "Cursor CLI exited abnormally while following WORKFLOW_PROMPTS.md workflow",
            metadata: {
              executionEngine: "cursor",
              stage: "execute",
              exitCode: 1,
              stderr:
                "execute stderr:\nError: Authentication required. Please run 'cursor agent login' first, or set CURSOR_API_KEY environment variable.\n"
            },
            createdAt: "2026-05-07T12:00:00.000Z"
          }
        ]}
      />
    );

    expect(screen.getByText("原因摘要")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("CURSOR_API_KEY");
    expect(screen.getByText("执行引擎")).toBeInTheDocument();
  });
});
