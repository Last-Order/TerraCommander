import type { BrowserWindow } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { channels } from '@shared/contracts';
import { defaultLanguageSettings, type LanguagePreference } from '@shared/language';
import type { Entry } from '@shared/storage';
import { AccountError } from '../accounts/core/errors';
import { registerIpcHandlers } from './';
import { ApplicationServices } from '../services/application-services';
import { DownloadPreferences } from '../services/downloads/download-preferences';
import { createDefaultStorageProviders } from '../services/storage/providers/default-providers';
import { StorageBrowser } from '../services/storage/storage-browser';
import { StoragePreferences } from '../services/storage/storage-preferences';
import { StorageTaskService } from '../services/tasks/storage-task-service';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  app: { getName: () => 'TerraCommander', getVersion: () => '0.1.0' },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    },
  },
}));

const activeServices: ApplicationServices[] = [];
afterEach(async () => {
  await Promise.all(activeServices.splice(0).map((services) => services.dispose()));
});

function setup() {
  handlers.clear();
  const entryUrl = 'file:///D:/app/index.html';
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const send = vi.fn();
  const webContents = {
    id: 1,
    mainFrame: { url: entryUrl },
    isDestroyed: () => false,
    send,
    on: vi.fn((eventName: string, callback: (...args: unknown[]) => void) => {
      const list = listeners.get(eventName) ?? [];
      list.push(callback);
      listeners.set(eventName, list);
    }),
    once: vi.fn((eventName: string, callback: (...args: unknown[]) => void) => {
      const list = listeners.get(eventName) ?? [];
      list.push(callback);
      listeners.set(eventName, list);
    }),
  };
  const window = { webContents } as unknown as BrowserWindow;
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const preferences = new StoragePreferences({ read: () => undefined, write() {} });
  const browser = new StorageBrowser({
    preferences,
    getAccounts: async () => {
      throw new Error('Accounts must not be initialized.');
    },
    logger: { event() {} },
    providers: createDefaultStorageProviders(preferences),
  });
  const services = new ApplicationServices({ whenReady: async () => {} });
  activeServices.push(services);
  const getBrowser = vi.spyOn(services.storageBrowser, 'get').mockResolvedValue(browser);
  const deleteEntry = vi.spyOn(browser, 'deleteEntry').mockResolvedValue(undefined);
  const setLanguage = vi.fn((preference: LanguagePreference) => ({
    preference,
    language: preference === 'en' ? ('en' as const) : ('zh-CN' as const),
  }));
  registerIpcHandlers(() => window, entryUrl, services, {
    get: () => defaultLanguageSettings,
    set: setLanguage,
  });
  const parent = { connectionId: 'local', spaceId: 'disk', locator: '.' };
  const entry: Entry = {
    ref: { connectionId: 'local', spaceId: 'disk', locator: 'notes.txt' },
    name: 'notes.txt',
    kind: 'file',
    capabilities: { remove: { support: 'supported' }, rename: { support: 'supported' } },
  };
  const emitWebContents = (eventName: string, ...args: unknown[]) => {
    for (const callback of listeners.get(eventName) ?? []) callback(...args);
  };
  return {
    event,
    parent,
    entry,
    browser,
    getBrowser,
    deleteEntry,
    services,
    setLanguage,
    send,
    emitWebContents,
  };
}

it('validates task delete and rename requests strictly before initializing task services', async () => {
  const { event, parent, entry, services, getBrowser, deleteEntry, send } = setup();
  const getTasks = vi.spyOn(services.tasks, 'get');
  const enqueueDelete = handlers.get(channels.enqueueDeleteTask)!;
  const enqueueRename = handlers.get(channels.enqueueRenameTask)!;
  const validDelete = { parent, entry, directoryPath: '/disk' };

  for (const args of [
    [],
    [null],
    [{ ...validDelete, entry: { ...entry, ref: { ...entry.ref, connectionId: 'invalid' } } }],
    [{ ...validDelete, mode: 'permanent' }],
    [validDelete, 'extra'],
  ]) {
    expect(await enqueueDelete(event, ...args)).toEqual({ ok: false, code: 'InvalidArgument' });
  }
  for (const args of [
    [],
    [{ parent, entry, name: '   ', directoryPath: '/disk' }],
    [{ parent, entry, name: 'a\0b', directoryPath: '/disk' }],
    [{ parent, entry, name: 'new.txt', directoryPath: '/disk', extra: true }],
  ]) {
    expect(await enqueueRename(event, ...args)).toEqual({ ok: false, code: 'InvalidArgument' });
  }
  expect(getTasks).not.toHaveBeenCalled();
  expect(getBrowser).not.toHaveBeenCalled();

  expect(await enqueueDelete(event, validDelete)).toEqual({ ok: true, value: true });
  await vi.waitFor(() => expect(deleteEntry).toHaveBeenCalledExactlyOnceWith(entry.ref));
  expect(send).toHaveBeenCalledWith(
    channels.taskEvent,
    expect.objectContaining({ type: 'snapshot' }),
  );
});

it('rejects untrusted senders on task channels before initializing task services', async () => {
  const { event, parent, entry, services, getBrowser } = setup();
  const getTasks = vi.spyOn(services.tasks, 'get');
  const enqueueDelete = handlers.get(channels.enqueueDeleteTask)!;
  const request = { parent, entry, directoryPath: '/disk' };

  for (const untrusted of [
    { ...event, sender: {} },
    { ...event, senderFrame: { url: 'https://example.com' } },
  ]) {
    await expect(enqueueDelete(untrusted, request)).rejects.toThrow('Untrusted IPC sender');
  }
  event.senderFrame.url = 'https://example.com';
  await expect(enqueueDelete(event, request)).rejects.toThrow('Untrusted IPC sender');
  expect(getTasks).not.toHaveBeenCalled();
  expect(getBrowser).not.toHaveBeenCalled();
});

it('reads download settings without loading storage or accounts', async () => {
  const { services, event, getBrowser } = setup();
  const preferences = new DownloadPreferences('system-downloads', {
    read: () => undefined,
    write() {},
  });
  const getPreferences = vi
    .spyOn(services.downloadPreferences, 'get')
    .mockResolvedValue(preferences);
  const get = handlers.get(channels.getDownloadSettings)!;
  expect(await get(event, 'unexpected')).toEqual({ ok: false, code: 'InvalidArgument' });
  expect(getPreferences).not.toHaveBeenCalled();
  expect(await get(event)).toEqual({
    ok: true,
    value: { directory: 'system-downloads' },
  });
  expect(getBrowser).not.toHaveBeenCalled();
  await expect(get({ ...event, sender: {} })).rejects.toThrow('Untrusted IPC sender');
});

it('validates coarse task download preparation, confirmation, and task control inputs', async () => {
  const { event, entry, parent, services, getBrowser } = setup();
  const getTasks = vi.spyOn(services.tasks, 'get');
  const id = '5e45885a-89f0-462e-9821-7195cba174e5';
  const remoteParent = { ...parent, connectionId: id };
  const remoteEntry = { ...entry, ref: { ...entry.ref, connectionId: id } };

  const prepareDownload = handlers.get(channels.prepareDownloadTask)!;
  const validPrepare = {
    parent: remoteParent,
    entries: [remoteEntry],
    directory: 'D:\\Downloads',
    directoryPath: '/Drive',
  };
  for (const invalid of [
    null,
    { ...validPrepare, entries: [] },
    { ...validPrepare, parent, entries: [entry] },
    { ...validPrepare, entries: [entry] },
    { ...validPrepare, replace: true },
    { ...validPrepare, directory: 'D:\\Bad\0Path' },
  ]) {
    expect(await prepareDownload(event, invalid)).toEqual({ ok: false, code: 'InvalidArgument' });
  }
  await expect(prepareDownload({ ...event, sender: {} }, validPrepare)).rejects.toThrow(
    'Untrusted IPC sender',
  );

  for (const channel of [channels.confirmDownloadTask, channels.cancelDownloadConfirmation]) {
    const handler = handlers.get(channel)!;
    for (const args of [[], ['not-a-uuid'], [id, 'extra']]) {
      expect(await handler(event, ...args)).toEqual({ ok: false, code: 'InvalidArgument' });
    }
    await expect(handler({ ...event, sender: {} }, id)).rejects.toThrow('Untrusted IPC sender');
  }

  for (const channel of [
    channels.pauseTask,
    channels.resumeTask,
    channels.cancelTask,
    channels.retryTask,
  ]) {
    const handler = handlers.get(channel)!;
    for (const args of [[], [0], [-1], [1.5], ['1'], [1, 'extra']]) {
      expect(await handler(event, ...args)).toEqual({ ok: false, code: 'InvalidArgument' });
    }
    await expect(handler({ ...event, sender: {} }, 1)).rejects.toThrow('Untrusted IPC sender');
  }

  for (const channel of [channels.getTaskSnapshot, channels.clearFinishedTasks]) {
    const handler = handlers.get(channel)!;
    expect(await handler(event, 'extra')).toEqual({ ok: false, code: 'InvalidArgument' });
    await expect(handler({ ...event, sender: {} })).rejects.toThrow('Untrusted IPC sender');
  }

  expect(getTasks).not.toHaveBeenCalled();
  expect(getBrowser).not.toHaveBeenCalled();
});

it('validates addConnection providers before initializing storage browser', async () => {
  const { event, getBrowser } = setup();
  const addConnection = handlers.get(channels.addConnection)!;
  for (const args of [[], ['local'], ['s3'], ['google-drive', 'extra']]) {
    expect(await addConnection(event, ...args)).toEqual({ ok: false, code: 'InvalidArgument' });
  }
  expect(getBrowser).not.toHaveBeenCalled();
});

it('uses BrowserResult contracts for app info and language handlers', async () => {
  const { event, setLanguage, getBrowser } = setup();
  const getAppInfo = handlers.get(channels.getAppInfo)!;
  const getLanguage = handlers.get(channels.getLanguage)!;
  const setLang = handlers.get(channels.setLanguage)!;

  expect(await getAppInfo(event)).toMatchObject({
    ok: true,
    value: { name: 'TerraCommander', version: '0.1.0' },
  });
  expect(await getAppInfo(event, 'extra')).toEqual({ ok: false, code: 'InvalidArgument' });
  expect(await getLanguage(event)).toEqual({ ok: true, value: defaultLanguageSettings });
  expect(await getLanguage(event, 'extra')).toEqual({ ok: false, code: 'InvalidArgument' });
  expect(await setLang(event, 'invalid')).toEqual({ ok: false, code: 'InvalidArgument' });
  expect(await setLang(event, 'en')).toEqual({
    ok: true,
    value: { preference: 'en', language: 'en' },
  });

  setLanguage.mockImplementationOnce(() => {
    throw new AccountError('PersistenceFailed');
  });
  expect(await setLang(event, 'zh-CN')).toEqual({ ok: false, code: 'PersistenceFailed' });
  await expect(getAppInfo({ ...event, sender: {} })).rejects.toThrow('Untrusted IPC sender');
  await expect(getLanguage({ ...event, sender: {} })).rejects.toThrow('Untrusted IPC sender');
  expect(getBrowser).not.toHaveBeenCalled();
});

it('cancels owner-scoped browser operations and pending task confirmations on crash or navigation', async () => {
  const { event, browser, services, emitWebContents } = setup();
  const taskService = new StorageTaskService(browser);
  vi.spyOn(services.tasks, 'get').mockResolvedValue(taskService);
  const cancelOwner = vi.spyOn(browser, 'cancelOwnerOperations');
  const cancelDownloads = vi.spyOn(browser.downloads, 'cancelOwner');
  const cancelAuth = vi.spyOn(browser, 'cancelAuthorization');
  const cancelConfirmations = vi.spyOn(taskService, 'cancelOwnerConfirmations');

  await handlers.get(channels.listConnections)!(event);
  await handlers.get(channels.getTaskSnapshot)!(event);

  emitWebContents('render-process-gone');
  expect(cancelOwner).toHaveBeenCalledTimes(1);
  expect(cancelOwner).toHaveBeenLastCalledWith(1);
  expect(cancelDownloads).toHaveBeenCalledTimes(1);
  expect(cancelAuth).toHaveBeenCalledTimes(1);
  expect(cancelConfirmations).toHaveBeenCalledTimes(1);
  expect(cancelConfirmations).toHaveBeenLastCalledWith(1);

  emitWebContents('did-start-navigation', undefined, 'about:blank', false, false);
  expect(cancelOwner).toHaveBeenCalledTimes(1);
  expect(cancelConfirmations).toHaveBeenCalledTimes(1);

  emitWebContents('did-start-navigation', undefined, 'https://example.com', false, true);
  expect(cancelOwner).toHaveBeenCalledTimes(2);
  expect(cancelConfirmations).toHaveBeenCalledTimes(2);

  await taskService.dispose();
});
