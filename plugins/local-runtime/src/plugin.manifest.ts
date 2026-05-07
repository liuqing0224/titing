import { ServerPluginManifest } from "../../../packages/core/src/plugins/plugin.manifest";
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
