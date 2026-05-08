import { ServerPluginManifest } from "@autodev-agent/plugin-api";
import { SseEventBusModule } from "./sse-event-bus.module";
import { SseEventBusService } from "./sse-event-bus.service";

export const sseEventBusPluginManifest: ServerPluginManifest = {
  id: "sse-event-bus",
  priority: 100,
  kind: "composite",
  module: SseEventBusModule,
  provides: {
    eventBus: SseEventBusService
  }
};
