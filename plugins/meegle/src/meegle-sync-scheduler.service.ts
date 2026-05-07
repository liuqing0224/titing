import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { AdapterService } from "./adapter.service";
import { SettingsService } from "./settings.service";

const JOB_NAME = "meegle-sync";

@Injectable()
export class MeegleSyncSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(MeegleSyncSchedulerService.name);
  private syncing = false;

  constructor(
    private readonly adapterService: AdapterService,
    private readonly settingsService: SettingsService,
    private readonly schedulerRegistry: SchedulerRegistry
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshSchedule();
  }

  async refreshSchedule(): Promise<void> {
    this.clearSchedule();
    const settings = await this.settingsService.getMeegleSyncSettings();
    if (!settings.enabled) {
      this.logger.log("Meegle auto sync disabled");
      return;
    }

    const intervalMs = settings.intervalMinutes * 60_000;
    const timer = setInterval(() => {
      void this.runScheduledSync();
    }, intervalMs);
    timer.unref?.();
    this.schedulerRegistry.addInterval(JOB_NAME, timer);
    this.logger.log(`Meegle auto sync scheduled every ${settings.intervalMinutes} minute(s)`);
  }

  private async runScheduledSync(): Promise<void> {
    if (this.syncing) {
      this.logger.warn("Skipping overlapping scheduled Meegle sync");
      return;
    }

    this.syncing = true;
    try {
      const result = await this.adapterService.sync();
      this.logger.log(`Scheduled Meegle sync finished: ${JSON.stringify(result.summary)}`);
    } catch (error) {
      this.logger.error(
        `Scheduled Meegle sync failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined
      );
    } finally {
      this.syncing = false;
    }
  }

  private clearSchedule(): void {
    try {
      const interval = this.schedulerRegistry.getInterval(JOB_NAME);
      clearInterval(interval);
      this.schedulerRegistry.deleteInterval(JOB_NAME);
    } catch {
      // No existing schedule to remove.
    }
  }
}
