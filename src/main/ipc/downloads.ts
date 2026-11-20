import { dialog } from 'electron';
import { z } from 'zod';
import { channels } from '@shared/contracts';
import type { TrustedIpc } from './helpers';

const pathSchema = z
  .string()
  .max(32_768)
  .refine((path) => !path.includes('\0'));

export function registerDownloadIpc(ipc: TrustedIpc): void {
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
