import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginMeegleLogin, pollMeegleLogin, syncMeegle } from "../api/adapter";
import { DashboardPage } from "./DashboardPage";

vi.mock("../api/adapter", () => ({
  syncMeegle: vi.fn(),
  beginMeegleLogin: vi.fn(),
  pollMeegleLogin: vi.fn()
}));

describe("DashboardPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens browser login when Meegle sync requires authentication", async () => {
    vi.mocked(syncMeegle).mockRejectedValue(new Error("Meegle login required"));
    vi.mocked(beginMeegleLogin).mockResolvedValue({
      clientId: "client",
      deviceCode: "device",
      expiresIn: 1,
      interval: 0,
      userCode: "ABC-123",
      verificationUri: "https://project.feishu.cn/b/auth/mcp",
      verificationUriComplete: "https://project.feishu.cn/b/auth/mcp?usercode=ABC-123"
    });
    vi.mocked(pollMeegleLogin).mockResolvedValue({
      authenticated: true,
      host: "project.feishu.cn"
    });
    vi.mocked(syncMeegle)
      .mockRejectedValueOnce(new Error("Meegle login required"))
      .mockResolvedValueOnce({
        summary: {
          created: 1,
          updated: 0,
          failed: 0,
          recovered: 0,
          resetToPending: 0
        },
        items: []
      });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);

    render(
      <DashboardPage
        stats={null}
        agents={[]}
        tasks={[]}
        refreshAll={vi.fn(async () => undefined)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "同步 Meegle" }));

    await waitFor(() => {
      expect(beginMeegleLogin).toHaveBeenCalled();
      expect(pollMeegleLogin).toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledWith(
        "https://project.feishu.cn/b/auth/mcp?usercode=ABC-123",
        "_blank",
        "noopener,noreferrer"
      );
      expect(alertSpy).toHaveBeenCalledWith(
        "已打开 Meegle 登录页面，系统会自动等待授权完成。验证码：ABC-123"
      );
    });
  });
});
