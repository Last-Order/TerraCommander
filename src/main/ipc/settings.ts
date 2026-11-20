import { z } from 'zod';
import { channels } from '@shared/contracts';
import { settingKeys, type AppSettingsMap, type SettingKey } from '@shared/settings';
import type { TrustedIpc } from './helpers';
import type { ApplicationServices } from '../services/application-services';
import { transferConcurrencySchema } from '../services/tasks/transfer-preferences';
import { StorageError } from '../storage';

const settingKeySchema = z.enum(settingKeys);

const pathSchema = z
  .string()
  .max(32_768)
  .refine((path) => !path.includes('\0'));

interface SettingDefinition<K extends SettingKey> {
  schema: z.ZodType<AppSettingsMap[K]>;
  get: (services: ApplicationServices) => Promise<AppSettingsMap[K]>;
  set: (services: ApplicationServices, value: AppSettingsMap[K]) => Promise<AppSettingsMap[K]>;
}

const settingDefinitions: { [K in SettingKey]: SettingDefinition<K> } = {
  'downloads.directory': {
    schema: pathSchema,
    get: async (services) => (await services.downloadPreferences.get()).get().directory,
    set: async (services, value) =>
      (await (await services.downloadPreferences.get()).set(value)).directory,
  },
  'transfers.concurrencyLimit': {
    schema: transferConcurrencySchema,
    get: async (services) => (await services.transferPreferences.get()).get().concurrencyLimit,
    set: async (services, value) =>
      (await services.transferPreferences.get()).setConcurrencyLimit(value).concurrencyLimit,
  },
};

async function setSetting<K extends SettingKey>(
  services: ApplicationServices,
  key: K,
  rawValue: unknown,
): Promise<AppSettingsMap[K]> {
  const definition = settingDefinitions[key];
  const parsed = definition.schema.safeParse(rawValue);
  if (!parsed.success) throw new StorageError('InvalidArgument');
  return definition.set(services, parsed.data);
}

export function registerSettingsIpc(ipc: TrustedIpc, services: ApplicationServices): void {
  ipc.handle(channels.getSetting, z.tuple([settingKeySchema]), async (_window, key) =>
    settingDefinitions[key].get(services),
  );
  ipc.handle(
    channels.setSetting,
    z.tuple([settingKeySchema, z.unknown()]),
    async (_window, key, value) => setSetting(services, key, value),
  );
}
