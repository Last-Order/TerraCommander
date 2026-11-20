import { app, dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { channels, type AppInfo } from '@shared/contracts';
import { localConnectionId } from '@shared/storage-browser';
import { registerDownloadIpc } from './downloads';
import { createTrustedIpc } from './helpers';
import { nativeMessages } from '../native-messages';
import { isTrustedRenderer } from '../security';
import type { ApplicationServices } from '../services/application-services';
import {
  languagePreferenceSchema,
  type LanguagePreferencesPort,
} from '../services/preferences/language-preferences';
import type { StorageBrowser } from '../services/storage/storage-browser';
import { entryRefSchema } from '../storage/core/validation';
import { registerTaskIpc } from './tasks';

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
  language: LanguagePreferencesPort,
): void {
  const ipc = createTrustedIpc(getWindow, entryUrl);
  const observedBrowsers = new WeakMap<StorageBrowser, Set<number>>();

  async function getStorageBrowser(window: BrowserWindow): Promise<StorageBrowser> {
    const browser = await services.storageBrowser.get();
    if (
      window.webContents.isDestroyed() ||
      !isTrustedRenderer(window.webContents.mainFrame.url, entryUrl)
    ) {
      throw new Error('Renderer session closed');
    }
    let owners = observedBrowsers.get(browser);
    if (!owners) {
      owners = new Set();
      observedBrowsers.set(browser, owners);
    }
    const owner = window.webContents.id;
    if (!owners.has(owner)) {
      owners.add(owner);
      ipc.observeRendererSession(window, (id) => browser.cancelOwnerOperations(id));
    }
    return browser;
  }

  ipc.handle(channels.getAppInfo, noArguments, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    versions: {
      electron: process.versions.electron ?? 'unknown',
      chromium: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
    },
  }));

  registerDownloadIpc(ipc, services);
  registerTaskIpc(ipc, entryUrl, services);

  ipc.handle(channels.getLanguage, noArguments, () => language.get());
  ipc.handle(channels.setLanguage, z.tuple([languagePreferenceSchema]), (_window, preference) =>
    language.set(preference),
  );

  function handleStorage<A extends unknown[], T>(
    channel: string,
    schema: z.ZodType<A>,
    run: (browser: StorageBrowser, window: BrowserWindow, ...args: A) => T | Promise<T>,
  ): void {
    ipc.handle(channel, schema, async (window, ...args) =>
      run(await getStorageBrowser(window), window, ...args),
    );
  }

  handleStorage(channels.listConnections, noArguments, (browser) => browser.listConnections());
  handleStorage(
    channels.listSpaces,
    z.tuple([connectionId, z.boolean().optional()]),
    (browser, _window, id, refresh?: boolean) => browser.listSpaces(id, refresh),
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
  handleStorage(
    channels.addConnection,
    z.tuple([z.enum(['google-drive'])]),
    (browser, window, provider) => browser.addConnection(provider, window.webContents.id),
  );
  handleStorage(channels.reauthorize, z.tuple([z.uuid()]), (browser, window, id) =>
    browser.reauthorize(id, window.webContents.id),
  );
  handleStorage(channels.cancelAuthorization, noArguments, (browser, window) =>
    browser.cancelAuthorization(window.webContents.id),
  );
  handleStorage(
    channels.listDirectory,
    z.tuple([directory, z.string().min(1).max(65_536).optional()]),
    (browser, _window, parent, cursor?: string) => browser.listDirectory(parent, cursor),
  );
  handleStorage(
    channels.measureDirectorySize,
    z.tuple([z.uuid(), z.array(directory).min(1)]),
    (browser, window, id, folders) =>
      browser.measureDirectorySize(id, folders, window.webContents.id),
  );
  handleStorage(channels.cancelDirectoryMeasurement, z.tuple([z.uuid()]), (browser, _window, id) =>
    browser.cancelDirectoryMeasurement(id),
  );
}
