import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./api/tasks", () => ({
  listTasks: vi.fn(async () => []),
  getTask: vi.fn(async () => ({})),
  listTaskLogs: vi.fn(async () => []),
  retryTask: vi.fn(async () => ({})),
  updateTaskExecutionFields: vi.fn(async () => ({}))
}));

vi.mock("./api/agents", () => ({
  listAgents: vi.fn(async () => [])
}));

vi.mock("./api/dashboard", () => ({
  getDashboardStats: vi.fn(async () => ({
    total: 0,
    pending: 0,
    queued: 0,
    running: 0,
    done: 0,
    failed: 0
  }))
}));

vi.mock("./api/events", () => ({
  connectEvents: vi.fn(() => vi.fn())
}));

describe("App", () => {
  it("renders the three MVP pages in the shell navigation", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "AutoDev Agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agents" })).toBeInTheDocument();
    expect(await screen.findByText("运维总览")).toBeInTheDocument();
  });
});
