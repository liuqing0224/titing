import { ServerPluginManifest } from "@autodev-agent/plugin-api";
import { TypeOrmStoreModule } from "./typeorm-store.module";
import { TypeOrmAgentStoreService } from "./typeorm-agent-store.service";
import { TypeOrmSettingsStoreService } from "./typeorm-settings-store.service";
import { TypeOrmTaskStoreService } from "./typeorm-task-store.service";

export const typeormStorePluginManifest: ServerPluginManifest = {
  id: "typeorm-store",
  priority: 100,
  kind: "composite",
  module: TypeOrmStoreModule,
  provides: {
    taskStore: TypeOrmTaskStoreService,
    agentStore: TypeOrmAgentStoreService,
    settingsStore: TypeOrmSettingsStoreService
  }
};
