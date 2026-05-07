import { ServerPluginManifest } from "../../../packages/core/src/plugins/plugin.manifest";
import { FileExecutionLogStoreService } from "./file-execution-log-store.service";
import { FileLogStoreModule } from "./file-log-store.module";

export const fileLogStorePluginManifest: ServerPluginManifest = {
  id: "file-log-store",
  priority: 100,
  kind: "composite",
  module: FileLogStoreModule,
  provides: {
    executionLogStore: FileExecutionLogStoreService
  }
};
