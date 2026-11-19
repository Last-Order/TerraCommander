import { dialog } from 'electron';
import { z } from 'zod';
import { channels } from '../../shared/contracts';
import type { TrustedIpc } from './helpers';
import type { ApplicationServices } from '../services/application-services';

const pathSchema = z
  .string()
  .max(32_768)
  .refine((path) => !path.includes('\0'));

export function registerDownloadIpc(ipc: TrustedIpc, services: ApplicationServices): void {
  ipc.handle(channels.getDownloadSettings, z.tuple([]), async () =>
    (await services.downloadPreferences.get()).get(),
  );
  ipc.handle(channels.setDownloadDirectory, z.tuple([pathSchema]), async (_window, path) =>
    (await services.downloadPreferences.get()).set(path),
  );
  ipc.handle(
    channels.chooseDownloadDirectory,
    z.tuple([pathSchema]),
    async (window, initialPath) => {
      const result = await dialog.showOpenDialog(window, {
        defaultPath: initialPath,
        properties: ['openDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
}
