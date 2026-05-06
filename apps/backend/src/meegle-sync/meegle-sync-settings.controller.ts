import { Body, Controller, Get, Put } from "@nestjs/common";
import { UpdateMeegleSyncSettingsDto } from "../settings/dto/update-meegle-sync-settings.dto";
import { MeegleSyncSettings, SettingsService } from "../settings/settings.service";
import { MeegleSyncSchedulerService } from "./meegle-sync-scheduler.service";

@Controller("settings/meegle-sync")
export class MeegleSyncSettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly meegleSyncSchedulerService: MeegleSyncSchedulerService
  ) {}

  @Get()
  getSettings(): Promise<MeegleSyncSettings> {
    return this.settingsService.getMeegleSyncSettings();
  }

  @Put()
  async updateSettings(@Body() body: UpdateMeegleSyncSettingsDto): Promise<MeegleSyncSettings> {
    const settings = await this.settingsService.saveMeegleSyncSettings(body);
    await this.meegleSyncSchedulerService.refreshSchedule();
    return settings;
  }
}
