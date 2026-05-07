export type SettingsStorePlugin = {
  getRecord<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  setRecord<T extends Record<string, unknown>>(key: string, value: T): Promise<void>;
};
