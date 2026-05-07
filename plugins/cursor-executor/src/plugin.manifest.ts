import { ServerPluginManifest } from "../../../packages/core/src/plugins/plugin.manifest";
import { CursorExecutorModule } from "./cursor-executor.module";
import { CursorRunner } from "./cursor-runner";

export const cursorExecutorPluginManifest: ServerPluginManifest = {
  id: "cursor-executor",
  priority: 110,
  kind: "execution-engine",
  module: CursorExecutorModule,
  provides: {
    executionEngine: CursorRunner
  }
};
