import { DynamicModule, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import * as path from "node:path";
import { CoreModule } from "../../../packages/core/src/core.module";
import { ServerPluginManifest } from "../../../packages/core/src/plugins/plugin.manifest";
import { PluginHostModule } from "../../../packages/core/src/plugins/plugin-host.module";

export function createAppModule(pluginManifests: ServerPluginManifest[]): DynamicModule {
  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        envFilePath: [
          path.resolve(process.cwd(), ".env"),
          path.resolve(process.cwd(), "../../.env"),
          path.resolve(__dirname, "../../../.env")
        ]
      }),
      ScheduleModule.forRoot(),
      PluginHostModule.register(pluginManifests),
      CoreModule
    ]
  })
  class RuntimeAppModule {}

  return {
    module: RuntimeAppModule
  };
}
