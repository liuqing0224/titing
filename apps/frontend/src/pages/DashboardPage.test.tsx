import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMeegle } from "../api/adapter";
import { DashboardPage } from "./DashboardPage";

vi.mock("../api/adapter", () => ({
  syncMeegle: vi.fn()
}));

describe("DashboardPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses backend sync flow and shows success summary", async () => {
    vi.mocked(syncMeegle).mockResolvedValue({
        summary: {
          created: 1,
          updated: 0,
          failed: 0,
          recovered: 0,
          resetToPending: 0
        },
        items: []
      });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const saveSettings = vi.fn(async () => undefined);

    render(
      <DashboardPage
        stats={null}
        agents={[]}
        tasks={[]}
        meegleSyncSettings={{ enabled: true, intervalMinutes: 5 }}
        refreshAll={vi.fn(async () => undefined)}
        onSaveMeegleSyncSettings={saveSettings}
        onOpenTask={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "同步 Meegle" }));

    await waitFor(() => {
      expect(syncMeegle).toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalledWith("sync: created 1, updated 0, failed 0, recovered 0");
    });
  });

  it("saves sync settings from the dashboard form", async () => {
    const saveSettings = vi.fn(async () => undefined);
    vi.spyOn(window, "alert").mockImplementation(() => undefined);

    render(
      <DashboardPage
        stats={null}
        agents={[]}
        tasks={[]}
        meegleSyncSettings={{ enabled: true, intervalMinutes: 5 }}
        refreshAll={vi.fn(async () => undefined)}
        onSaveMeegleSyncSettings={saveSettings}
        onOpenTask={vi.fn()}
      />
    );

    fireEvent.change(screen.getByDisplayValue("5"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "保存自动同步配置" }));

    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith({
        enabled: true,
        intervalMinutes: 10
      });
    });
  });
});
