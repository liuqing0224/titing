import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SystemSetting } from "./system-setting.entity";

export type MeegleSyncSettings = {
  enabled: boolean;
  intervalMinutes: number;
};

export type MeegleLoginState = {
  browserPending: boolean;
  verificationUri: string | null;
  userCode: string | null;
};

const MEEGLE_SYNC_SETTINGS_KEY = "meegle_sync_settings";
const MEEGLE_LOGIN_STATE_KEY = "meegle_login_state";

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(SystemSetting)
    private readonly settingsRepository: Repository<SystemSetting>,
    private readonly configService: ConfigService
  ) {}

  async getMeegleSyncSettings(): Promise<MeegleSyncSettings> {
    const stored = await this.settingsRepository.findOne({ where: { key: MEEGLE_SYNC_SETTINGS_KEY } });
    const defaults = this.getDefaultMeegleSyncSettings();
    if (!stored) {
      return defaults;
    }

    return {
      enabled: this.readBoolean(stored.value.enabled, defaults.enabled),
      intervalMinutes: this.readInterval(stored.value.intervalMinutes, defaults.intervalMinutes)
    };
  }

  async saveMeegleSyncSettings(input: MeegleSyncSettings): Promise<MeegleSyncSettings> {
    const normalized = {
      enabled: Boolean(input.enabled),
      intervalMinutes: this.readInterval(input.intervalMinutes, this.getDefaultMeegleSyncSettings().intervalMinutes)
    };
    await this.saveSetting(MEEGLE_SYNC_SETTINGS_KEY, normalized);
    return normalized;
  }

  async getMeegleLoginState(): Promise<MeegleLoginState> {
    const stored = await this.settingsRepository.findOne({ where: { key: MEEGLE_LOGIN_STATE_KEY } });
    return {
      browserPending: this.readBoolean(stored?.value.browserPending, false),
      verificationUri: this.readString(stored?.value.verificationUri),
      userCode: this.readString(stored?.value.userCode)
    };
  }

  async setMeegleLoginState(input: MeegleLoginState): Promise<MeegleLoginState> {
    const normalized = {
      browserPending: Boolean(input.browserPending),
      verificationUri: input.verificationUri?.trim() || null,
      userCode: input.userCode?.trim() || null
    };
    await this.saveSetting(MEEGLE_LOGIN_STATE_KEY, normalized);
    return normalized;
  }

  private getDefaultMeegleSyncSettings(): MeegleSyncSettings {
    return {
      enabled: this.readBoolean(this.configService.get<string>("MEEGLE_SYNC_ENABLED", "true"), true),
      intervalMinutes: this.readInterval(this.configService.get<string>("MEEGLE_SYNC_INTERVAL_MINUTES", "5"), 5)
    };
  }

  private async saveSetting(key: string, value: Record<string, unknown>): Promise<void> {
    const existing = await this.settingsRepository.findOne({ where: { key } });
    const entity = existing ?? this.settingsRepository.create({ key, value });
    entity.value = value;
    await this.settingsRepository.save(entity);
  }

  private readBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return value.toLowerCase() === "true";
    }
    return fallback;
  }

  private readInterval(value: unknown, fallback: number): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < 1) {
      return fallback;
    }
    return Math.floor(numeric);
  }

  private readString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  }
}
