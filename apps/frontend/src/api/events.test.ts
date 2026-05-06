import { afterEach, describe, expect, it, vi } from "vitest";
import { connectEvents } from "./events";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Array<(event?: MessageEvent<string>) => void>>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {}

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(data ? ({ data } as MessageEvent<string>) : undefined);
    }
  }
}

describe("connectEvents", () => {
  afterEach(() => {
    FakeEventSource.instances = [];
  });

  it("refreshes all snapshots when task or agent events arrive", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const refreshAll = vi.fn();

    const disconnect = connectEvents({ refreshAll });
    const source = FakeEventSource.instances.at(-1)!;

    expect(source.url).toBe("http://localhost:3000/api/events");

    source.emit("task.lifecycle");
    source.emit("agent.status");

    expect(refreshAll).toHaveBeenCalledTimes(2);
    disconnect();
  });

  it("opens Meegle login handler when login-required events arrive", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onMeegleLoginRequired = vi.fn();

    const disconnect = connectEvents({ refreshAll: vi.fn(), onMeegleLoginRequired });
    const source = FakeEventSource.instances.at(-1)!;

    source.emit(
      "meegle.login_required",
      JSON.stringify({
        verificationUri: "https://project.feishu.cn/b/auth/mcp?usercode=ABC-123",
        userCode: "ABC-123",
        timestamp: "2026-05-06T12:00:00.000Z"
      })
    );

    expect(onMeegleLoginRequired).toHaveBeenCalledWith({
      verificationUri: "https://project.feishu.cn/b/auth/mcp?usercode=ABC-123",
      userCode: "ABC-123",
      timestamp: "2026-05-06T12:00:00.000Z"
    });
    disconnect();
  });
});
