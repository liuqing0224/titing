import { ServerPluginManifest } from "@autodev-agent/plugin-api";
import { OpsConsoleModule } from "./ops-console.module";

export const opsConsolePluginManifest: ServerPluginManifest = {
  id: "ops-console",
  priority: 100,
  kind: "ui-backend",
  module: OpsConsoleModule,
  web: [
    {
      id: "ops-console",
      title: "Ops Console",
      entryPath: "plugins/ops-console/web"
    }
  ]
};
