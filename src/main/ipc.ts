import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { channels, type AppInfo } from '../shared/contracts';
import { localConnectionId, type BrowserResult } from '../shared/storage-browser';
import { AccountError } from './accounts/core/errors';
import { nativeMessages } from './native-messages';
import { isTrustedRenderer } from './security';
import type { ApplicationServices } from './services/application-services';
import {
  languagePreferenceSchema,
  type LanguagePreferences,
} from './services/language-preferences';
import type { StorageBrowser } from './services/storage-browser';
import { normalizeStorageError } from './storage/core/errors';
import { entryRefSchema } from './storage/core/validation';

const connectionId = z.union([z.literal(localConnectionId), z.uuid()]);
const spaceId = z.string().min(1).max(1024);
const directory = entryRefSchema.extend({
  connectionId,
  spaceId,
  locator: z.string().min(1).max(32_768),
});
const noArguments = z.tuple([]);

export function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  entryUrl: string,
  services: ApplicationServices,
  language: LanguagePreferences,
): void {
  function assertTrusted(event: IpcMainInvokeEvent): BrowserWindow {
    const window = getWindow();
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedRenderer(event.senderFrame.url, entryUrl)
    ) {
      throw new Error('Untrusted IPC sender');
    }
    return window;
  }

  ipcMain.handle(channels.getAppInfo, (event): AppInfo => {
    assertTrusted(event);
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      versions: {
        electron: process.versions.electron ?? 'unknown',
        chromium: process.versions.chrome ?? 'unknown',
        node: process.versions.node,
      },
    };
  });

  ipcMain.handle(channels.getLanguage, (event, ...args: unknown[]) => {
    assertTrusted(event);
    if (!noArguments.safeParse(args).success)
      throw new Error('Unexpected language settings arguments');
    return language.get();
  });
  const setLanguageArguments = z.tuple([languagePreferenceSchema]);
  ipcMain.handle(channels.setLanguage, (event, ...args: unknown[]) => {
    assertTrusted(event);
    const parsed = setLanguageArguments.safeParse(args);
    return parsed.success ? language.set(parsed.data[0]) : null;
  });

  function handleStorage<A extends unknown[], T>(
    channel: string,
    schema: z.ZodType<A>,
    run: (browser: StorageBrowser, window: BrowserWindow, ...args: A) => T | Promise<T>,
  ): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<BrowserResult<T>> => {
      const window = assertTrusted(event);
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { ok: false, code: 'InvalidArgument' };
      try {
        const browser = await services.storageBrowser.get();
        return { ok: true, value: await run(browser, window, ...parsed.data) };
      } catch (error) {
        const code = error instanceof AccountError ? error.code : normalizeStorageError(error).code;
        return { ok: false, code };
      }
    });
  }

  handleStorage(channels.listConnections, noArguments, (browser) => browser.listConnections());
  handleStorage(channels.listSpaces, z.tuple([connectionId]), (browser, _window, id) =>
    browser.listSpaces(id),
  );
  handleStorage(
    channels.saveSpaces,
    z.tuple([connectionId, z.array(spaceId).refine((ids) => new Set(ids).size === ids.length)]),
    (browser, _window, id, spaces) => browser.saveSpaces(id, spaces),
  );
  handleStorage(channels.chooseFolder, noArguments, async (browser, window) => {
    const result = await dialog.showOpenDialog(window, {
      title: nativeMessages[language.get().language].chooseFolder,
      properties: ['openDirectory'],
    });
    const folder = result.filePaths[0];
    return result.canceled || !folder ? null : browser.addLocalFolder(folder);
  });
  handleStorage(channels.addGoogleDrive, noArguments, (browser) => browser.addGoogleDrive());
  handleStorage(channels.reauthorize, z.tuple([z.uuid()]), (browser, _window, id) =>
    browser.reauthorize(id),
  );
  handleStorage(channels.cancelAuthorization, noArguments, (browser) =>
    browser.cancelAuthorization(),
  );
  handleStorage(
    channels.listDirectory,
    z.tuple([directory, z.string().min(1).max(65_536).optional()]),
    (browser, _window, parent, cursor?: string) => browser.listDirectory(parent, cursor),
  );
  handleStorage(
    channels.measureDirectorySize,
    z.tuple([z.uuid(), z.array(directory).min(1)]),
    (browser, _window, id, folders) => browser.measureDirectorySize(id, folders),
  );
  handleStorage(channels.cancelDirectoryMeasurement, z.tuple([z.uuid()]), (browser, _window, id) =>
    browser.cancelDirectoryMeasurement(id),
  );
}
