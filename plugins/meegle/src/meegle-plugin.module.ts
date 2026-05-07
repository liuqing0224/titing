import { Module } from "@nestjs/common";
import { AdapterModule } from "./adapter.module";
import { MeegleSyncModule } from "./meegle-sync.module";
import { SettingsModule } from "./settings.module";

@Module({
  imports: [SettingsModule, AdapterModule, MeegleSyncModule],
  exports: [SettingsModule, AdapterModule, MeegleSyncModule]
})
export class MeeglePluginModule {}
