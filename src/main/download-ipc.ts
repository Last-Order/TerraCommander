import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { channels } from '../shared/contracts';
import type { BrowserResult } from '../shared/storage-browser';
import type { ApplicationServices } from './services/application-services';
import { DownloadError } from './services/download-paths';
import { AccountError } from './accounts/core/errors';
import { normalizeStorageError } from './storage/core/errors';
import { entryRefSchema } from './storage/core/validation';
import { isTrustedRenderer } from './security';

const pathSchema = z
  .string()
  .max(32_768)
  .refine((path) => !path.includes('\0'));

export function registerDownloadIpc(
  assertTrusted: (event: IpcMainInvokeEvent) => BrowserWindow,
  entryUrl: string,
  services: ApplicationServices,
) {
  const observed = new Set<number>();
  function handle<A extends unknown[], T>(
    channel: string,
    schema: z.ZodType<A>,
    run: (window: BrowserWindow, ...args: A) => Promise<T>,
  ) {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<BrowserResult<T>> => {
      const window = assertTrusted(event);
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { ok: false, code: 'InvalidArgument' };
      try {
        return { ok: true, value: await run(window, ...parsed.data) };
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof DownloadError || error instanceof AccountError
              ? error.code
              : normalizeStorageError(error).code,
        };
      }
    });
  }
  async function downloads(window: BrowserWindow) {
    const browser = await services.storageBrowser.get();
    if (
      window.webContents.isDestroyed() ||
      !isTrustedRenderer(window.webContents.mainFrame.url, entryUrl)
    )
      throw new Error('Renderer session closed');
    const owner = window.webContents.id;
    if (!observed.has(owner)) {
      observed.add(owner);
      const cancel = () => browser.downloads.cancelOwner(owner);
      window.webContents.on('render-process-gone', cancel);
      window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) cancel();
      });
      window.webContents.once('destroyed', () => {
        cancel();
        observed.delete(owner);
      });
    }
    return browser.downloads;
  }
  handle(channels.getDownloadSettings, z.tuple([]), async () =>
    (await services.downloadPreferences.get()).get(),
  );
  handle(channels.setDownloadDirectory, z.tuple([pathSchema]), async (_window, path) =>
    (await services.downloadPreferences.get()).set(path),
  );
  handle(channels.chooseDownloadDirectory, z.tuple([pathSchema]), async (window, initialPath) => {
    const result = await dialog.showOpenDialog(window, {
      defaultPath: initialPath,
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(
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
  handle(channels.runDownload, z.tuple([z.uuid(), z.uuid()]), async (window, id, attempt) => {
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
  handle(channels.pauseDownload, z.tuple([z.uuid()]), async (window, id) =>
    (await downloads(window)).pause(window.webContents.id, id),
  );
  handle(channels.cancelDownload, z.tuple([z.uuid()]), async (window, id) =>
    (await downloads(window)).cancel(window.webContents.id, id),
  );
}
