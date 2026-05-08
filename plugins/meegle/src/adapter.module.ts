import { Module } from "@nestjs/common";
import { AdapterController } from "./adapter.controller";
import { AdapterService } from "./adapter.service";
import { BrowserLauncherService } from "./browser-launcher.service";
import { MeegleAdapter } from "./meegle.adapter";
import { MeegleResultReporterPlugin } from "./meegle-result-reporter.plugin";
import { MeegleTaskSourcePlugin } from "./meegle-task-source.plugin";
import { SettingsModule } from "./settings.module";

@Module({
  imports: [SettingsModule],
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
