import { dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { channels } from '../shared/contracts';
import type { TrustedIpc } from './ipc-helpers';
import { isTrustedRenderer } from './security';
import type { ApplicationServices } from './services/application-services';
import type { StorageBrowser } from './services/storage-browser';
import { entryRefSchema } from './storage/core/validation';

const pathSchema = z
  .string()
  .max(32_768)
  .refine((path) => !path.includes('\0'));

export function registerDownloadIpc(
  ipc: TrustedIpc,
  entryUrl: string,
  services: ApplicationServices,
  getBrowser: (window: BrowserWindow) => Promise<StorageBrowser>,
) {
  async function downloads(window: BrowserWindow) {
    return (await getBrowser(window)).downloads;
  }
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
  ipc.handle(
    channels.prepareDownload,
    z.tuple([
      z.strictObject({
        ref: entryRefSchema.extend({ connectionId: z.uuid() }),
        directory: pathSchema,
        expectedName: z.string().min(1).max(32_768),
        replace: z.boolean(),
      }),
    ]),
    async (window, request) => (await downloads(window)).prepare(window.webContents.id, request),
  );
  ipc.handle(channels.runDownload, z.tuple([z.uuid(), z.uuid()]), async (window, id, attempt) => {
    const service = await downloads(window);
    return service.run(
      window.webContents.id,
      id,
      (progress) => {
        try {
          if (
            !window.webContents.isDestroyed() &&
            isTrustedRenderer(window.webContents.mainFrame.url, entryUrl)
          )
            window.webContents.send(channels.downloadProgress, progress);
        } catch {
          /* A closed renderer must not interrupt file publication or cleanup. */
        }
      },
      attempt,
    );
  });
  ipc.handle(
    channels.prepareDownloadBatch,
    z.tuple([
      z.strictObject({
        directory: pathSchema,
        entries: z
          .array(
            z.strictObject({
              ref: entryRefSchema.extend({ connectionId: z.uuid() }),
              expectedName: z.string().min(1).max(32_768),
            }),
          )
          .min(1)
          .max(100_000),
      }),
    ]),
    async (window, request) =>
      (await downloads(window)).prepareBatch(window.webContents.id, request),
  );
  ipc.handle(channels.confirmDownloadBatch, z.tuple([z.uuid()]), async (window, id) =>
    (await downloads(window)).confirmBatch(window.webContents.id, id),
  );
  const index = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
  ipc.handle(
    channels.discoverDownloadDirectory,
    z.tuple([z.uuid(), index, index]),
    async (window, id, itemId, offset) =>
      (await downloads(window)).discoverBatchDirectory(window.webContents.id, id, itemId, offset),
  );
  const work = z.strictObject({ planId: z.uuid(), itemId: index });
  ipc.handle(channels.resolveDownloadWork, z.tuple([work]), async (window, ref) =>
    (await downloads(window)).resolveWork(window.webContents.id, ref),
  );
  ipc.handle(channels.cancelDownloadWork, z.tuple([work]), async (window, ref) =>
    (await downloads(window)).cancelWork(window.webContents.id, ref),
  );
  ipc.handle(channels.releaseDownloadWork, z.tuple([work]), async (window, ref) =>
    (await downloads(window)).releaseWork(window.webContents.id, ref),
  );
  ipc.handle(
    channels.cancelDownloadBatchItem,
    z.tuple([z.uuid(), index]),
    async (window, id, itemId) =>
      (await downloads(window)).cancelBatchItem(window.webContents.id, id, itemId),
  );
  ipc.handle(channels.finishDownloadBatch, z.tuple([z.uuid()]), async (window, id) =>
    (await downloads(window)).finishBatch(window.webContents.id, id),
  );
  ipc.handle(channels.releaseDownloadBatch, z.tuple([z.uuid()]), async (window, id) =>
    (await downloads(window)).releaseBatch(window.webContents.id, id),
  );
  ipc.handle(channels.pauseDownload, z.tuple([z.uuid()]), async (window, id) =>
    (await downloads(window)).pause(window.webContents.id, id),
  );
  ipc.handle(channels.cancelDownload, z.tuple([z.uuid()]), async (window, id) =>
    (await downloads(window)).cancel(window.webContents.id, id),
  );
}
