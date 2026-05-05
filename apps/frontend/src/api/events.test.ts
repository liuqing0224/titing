import { describe, expect, it, vi } from "vitest";
import { connectEvents } from "./events";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Array<() => void>>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {}

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

describe("connectEvents", () => {
  it("refreshes all snapshots when task or agent events arrive", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const refreshAll = vi.fn();

    const disconnect = connectEvents(refreshAll);
    const source = FakeEventSource.instances[0];

    expect(source.url).toBe("http://localhost:3000/api/events");

    source.emit("task.lifecycle");
    source.emit("agent.status");

    expect(refreshAll).toHaveBeenCalledTimes(2);
    disconnect();
  });
});
