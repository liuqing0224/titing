import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { ExecutionLogModal } from "./ExecutionLogModal";

describe("ExecutionLogModal", () => {
  it("renders structured execution metadata for project-directory runs", () => {
    render(
      <ExecutionLogModal
        logs={[
          {
            id: "log-1",
            taskId: "auto-1",
            agentId: "agent-1",
            status: "done",
            message: "Codex exited normally",
            metadata: {
              repo: "git@example.com:team/project.git",
              branch: "feature/demo",
              repoRoot: "/tmp/autodev-agent/workspaces/team/project",
              worktreePath: "/tmp/autodev-agent/workspaces/.worktrees/team_project/auto-1",
              exitCode: 0,
              normalExit: true
            },
            createdAt: "2026-05-05T12:00:00.000Z"
          }
        ]}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Codex exited normally")).toBeInTheDocument();
    expect(screen.getByText(/feature\/demo/)).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/autodev-agent\/workspaces\/.worktrees\/team_project\/auto-1/)).toBeInTheDocument();
    expect(screen.getByText("exitCode")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("normalExit")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
  });
});
