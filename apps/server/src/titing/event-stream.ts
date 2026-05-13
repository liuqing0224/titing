/**
 * 观测事件视图：`EventSink` + 订阅与快照（生产环境由 `FileLogEventStream` 委托 `LogPlugin`）。
 */
import { EventSink, ObservabilityEvent } from "@titing/plugin-api";

export interface EventStreamView extends EventSink {
  subscribe(listener: (event: ObservabilityEvent) => void): () => void;
  snapshot(): ObservabilityEvent[];
}

/** 内存实现：环形保留最近事件，单机测试或占位用。 */
export class InMemoryEventStream implements EventStreamView {
  private readonly listeners = new Set<(event: ObservabilityEvent) => void>();
  private readonly recentEvents: ObservabilityEvent[] = [];

  async publish(event: ObservabilityEvent): Promise<void> {
    this.recentEvents.push(event);
    if (this.recentEvents.length > 200) {
      this.recentEvents.shift();
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: (event: ObservabilityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): ObservabilityEvent[] {
    return [...this.recentEvents];
  }
}
