import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SettingsStorePlugin } from "@autodev-agent/plugin-api";
import { StoredSetting } from "./stored-setting.entity";

@Injectable()
export class TypeOrmSettingsStoreService implements SettingsStorePlugin {
  constructor(
    @InjectRepository(StoredSetting)
    private readonly settingsRepository: Repository<StoredSetting>
  ) {}

  async getRecord<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    const stored = await this.settingsRepository.findOne({ where: { key } });
    return (stored?.value as T | undefined) ?? null;
  }

  async setRecord<T extends Record<string, unknown>>(key: string, value: T): Promise<void> {
    const existing = await this.settingsRepository.findOne({ where: { key } });
    const entity = existing ?? this.settingsRepository.create({ key, value });
    entity.value = value;
    await this.settingsRepository.save(entity);
  }
}
