import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventsModule } from "../events/events.module";
import { ExecutionLogModule } from "../execution-logs/execution-log.module";
import { SettingsModule } from "../settings/settings.module";
import { Task } from "../tasks/task.entity";
import { TASK_RESULT_REPORTER_PLUGINS } from "../plugins/plugin.tokens";
import { AdapterController } from "./adapter.controller";
import { AdapterService } from "./adapter.service";
import { BrowserLauncherService } from "./browser-launcher.service";
import { MeegleAdapter } from "./meegle.adapter";
import { MeegleResultReporterPlugin } from "./meegle-result-reporter.plugin";
import { MeegleTaskSourcePlugin } from "./meegle-task-source.plugin";

@Module({
  imports: [TypeOrmModule.forFeature([Task]), ExecutionLogModule, EventsModule, SettingsModule],
  controllers: [AdapterController],
  providers: [
    AdapterService,
    BrowserLauncherService,
    MeegleAdapter,
    MeegleTaskSourcePlugin,
    MeegleResultReporterPlugin,
    {
      provide: TASK_RESULT_REPORTER_PLUGINS,
      useFactory: (meegleReporter: MeegleResultReporterPlugin) => [meegleReporter],
      inject: [MeegleResultReporterPlugin]
    }
  ],
  exports: [AdapterService, BrowserLauncherService, MeegleAdapter, MeegleTaskSourcePlugin, TASK_RESULT_REPORTER_PLUGINS]
})
export class AdapterModule {}
