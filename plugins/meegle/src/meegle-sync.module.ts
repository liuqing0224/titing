import { Module } from "@nestjs/common";
import { AdapterModule } from "./adapter.module";
import { SettingsModule } from "./settings.module";
import { MeegleSyncSchedulerService } from "./meegle-sync-scheduler.service";
import { MeegleSyncSettingsController } from "./meegle-sync-settings.controller";

@Module({
  imports: [AdapterModule, SettingsModule],
  controllers: [MeegleSyncSettingsController],
  providers: [MeegleSyncSchedulerService],
  exports: [MeegleSyncSchedulerService]
})
export class MeegleSyncModule {}
