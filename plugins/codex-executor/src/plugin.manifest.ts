import { ServerPluginManifest } from "@autodev-agent/plugin-api";
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
