import { ServerPluginManifest } from "@autodev-agent/plugin-api";
import { LocalRuntimeModule } from "./local-runtime.module";
import { LocalAgentRuntimeService } from "./local-agent-runtime.service";

export const localRuntimePluginManifest: ServerPluginManifest = {
  id: "local-runtime",
  priority: 100,
  kind: "agent-runtime",
  module: LocalRuntimeModule,
  provides: {
    agentRuntime: LocalAgentRuntimeService
  }
};
