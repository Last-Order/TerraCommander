import type { BrowserResult } from './storage-browser';

export const settingKeys = ['downloads.directory', 'transfers.concurrencyLimit'] as const;

export type SettingKey = (typeof settingKeys)[number];

export interface AppSettingsMap {
  'downloads.directory': string;
  'transfers.concurrencyLimit': number;
}

export interface SettingsApi {
  get<K extends SettingKey>(key: K): Promise<BrowserResult<AppSettingsMap[K]>>;
  set<K extends SettingKey>(
    key: K,
    value: AppSettingsMap[K],
  ): Promise<BrowserResult<AppSettingsMap[K]>>;
}
