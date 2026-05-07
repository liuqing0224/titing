import { ServerPluginManifest } from "../../../packages/core/src/plugins/plugin.manifest";
import { CodexExecutorModule } from "./codex-executor.module";
import { CodexRunner } from "./codex-runner";

export const codexExecutorPluginManifest: ServerPluginManifest = {
  id: "codex-executor",
  priority: 100,
  kind: "execution-engine",
  module: CodexExecutorModule,
  provides: {
    executionEngine: CodexRunner
  }
};
