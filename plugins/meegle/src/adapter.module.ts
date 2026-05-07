import { Module } from "@nestjs/common";
import { EventsModule } from "../../../packages/core/src/events/events.module";
import { ExecutionLogModule } from "../../../packages/core/src/execution-logs/execution-log.module";
import { AdapterController } from "./adapter.controller";
import { AdapterService } from "./adapter.service";
import { BrowserLauncherService } from "./browser-launcher.service";
import { MeegleAdapter } from "./meegle.adapter";
import { MeegleResultReporterPlugin } from "./meegle-result-reporter.plugin";
import { MeegleTaskSourcePlugin } from "./meegle-task-source.plugin";
import { SettingsModule } from "./settings.module";

@Module({
  imports: [ExecutionLogModule, EventsModule, SettingsModule],
  controllers: [AdapterController],
  providers: [
    AdapterService,
    BrowserLauncherService,
    MeegleAdapter,
    MeegleTaskSourcePlugin,
    MeegleResultReporterPlugin
  ],
  exports: [
    AdapterService,
    BrowserLauncherService,
    MeegleAdapter,
    MeegleTaskSourcePlugin,
    MeegleResultReporterPlugin
  ]
})
export class AdapterModule {}
