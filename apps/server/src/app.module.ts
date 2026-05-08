import { DynamicModule, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import * as path from "node:path";
import { ServerPluginManifest } from "@autodev-agent/plugin-api";
import { CoreModule, PluginHostModule } from "@autodev-agent/core";

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
