import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventsModule } from "../events/events.module";
import { ExecutionLogModule } from "../execution-logs/execution-log.module";
import { SettingsModule } from "../settings/settings.module";
import { Task } from "../tasks/task.entity";
import { AdapterController } from "./adapter.controller";
import { AdapterService } from "./adapter.service";
import { BrowserLauncherService } from "./browser-launcher.service";
import { MeegleAdapter } from "./meegle.adapter";

@Module({
  imports: [TypeOrmModule.forFeature([Task]), ExecutionLogModule, EventsModule, SettingsModule],
  controllers: [AdapterController],
  providers: [AdapterService, BrowserLauncherService, MeegleAdapter],
  exports: [AdapterService, BrowserLauncherService, MeegleAdapter]
})
export class AdapterModule {}
