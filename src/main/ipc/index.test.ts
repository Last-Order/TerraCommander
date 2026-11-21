import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, OpenDialogReturnValue } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { channels } from '@shared/contracts';
import { defaultLanguageSettings, type LanguagePreference } from '@shared/language';
import type { Entry } from '@shared/storage';
import { AccountError } from '../accounts/core/errors';
import { StorageError, type WriteExecution } from '../storage';
import { registerIpcHandlers } from './';
import { ApplicationServices } from '../services/application-services';
import { DownloadPreferences } from '../services/downloads/download-preferences';
import { createDefaultStorageProviders } from '../services/storage/providers/default-providers';
import { StorageBrowser } from '../services/storage/storage-browser';
import { StoragePreferences } from '../services/storage/storage-preferences';
import { StorageTaskService } from '../services/tasks/storage-task-service';
import { TransferPreferences } from '../services/tasks/transfer-preferences';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const picker = vi.hoisted(() => vi.fn<() => Promise<OpenDialogReturnValue>>());
vi.mock('electron', () => ({
  app: { getName: () => 'TerraCommander', getVersion: () => '0.1.0' },
  dialog: { showOpenDialog: picker },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    },
  },
}));

const activeServices: ApplicationServices[] = [];
afterEach(async () => {
  picker.mockReset();
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
  const transferPreferences = new TransferPreferences({ read: () => undefined, write() {} });
  vi.spyOn(services.transferPreferences, 'get').mockResolvedValue(transferPreferences);
  const getBrowser = vi.spyOn(services.storageBrowser, 'get').mockResolvedValue(browser);
  const createDirectory = vi.spyOn(browser, 'createDirectory').mockResolvedValue({
    ref: { connectionId: 'local', spaceId: 'disk', locator: 'projects' },
    name: 'projects',
    kind: 'directory',
    capabilities: { list: { support: 'supported' } },
  });
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
    createDirectory,
    deleteEntry,
    services,
    transferPreferences,
    setLanguage,
    send,
    emitWebContents,
  };
}

it('reads and updates settings via the generic settings IPC without loading storage or tasks', async () => {
  const { event, services, getBrowser } = setup();
  const getTasks = vi.spyOn(services.tasks, 'get');
  const getSetting = handlers.get(channels.getSetting)!;
  const setSetting = handlers.get(channels.setSetting)!;

  expect(await getSetting(event, 'unknown.key')).toEqual({ ok: false, code: 'InvalidArgument' });
  expect(await getSetting(event, 'transfers.concurrencyLimit')).toEqual({ ok: true, value: 8 });
  expect(await setSetting(event, 'transfers.concurrencyLimit', 0)).toEqual({
    ok: false,
    code: 'InvalidArgument',
  });
  expect(await setSetting(event, 'transfers.concurrencyLimit', 33)).toEqual({
    ok: false,
    code: 'InvalidArgument',
  });
  expect(await setSetting(event, 'transfers.concurrencyLimit', '12')).toEqual({
    ok: false,
    code: 'InvalidArgument',
  });
  expect(await setSetting(event, 'transfers.concurrencyLimit', 12)).toEqual({
    ok: true,
    value: 12,
  });
  expect(await getSetting(event, 'transfers.concurrencyLimit')).toEqual({ ok: true, value: 12 });
  expect(getBrowser).not.toHaveBeenCalled();
  expect(getTasks).not.toHaveBeenCalled();
});

it('validates task delete, rename, and create-directory requests strictly before initializing task services', async () => {
  const { event, parent, entry, services, getBrowser, createDirectory, deleteEntry, send } =
    setup();
  const getTasks = vi.spyOn(services.tasks, 'get');
  const enqueueCreateDirectory = handlers.get(channels.enqueueCreateDirectoryTask)!;
  const enqueueDelete = handlers.get(channels.enqueueDeleteTask)!;
  const enqueueRename = handlers.get(channels.enqueueRenameTask)!;
  const validDelete = { parent, entries: [entry], directoryPath: '/disk' };
  const validCreateDirectory = { parent, name: 'projects', directoryPath: '/disk' };

  for (const args of [
    [],
    [null],
    [{ ...validDelete, entries: [] }],
    [{ ...validDelete, entries: [{ ...entry, ref: { ...entry.ref, connectionId: 'invalid' } }] }],
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
  for (const args of [
    [],
    [null],
    [{ parent, name: '   ', directoryPath: '/disk' }],
    [{ parent, name: 'a\0b', directoryPath: '/disk' }],
    [{ parent: { ...parent, connectionId: 'invalid' }, name: 'projects', directoryPath: '/disk' }],
    [{ ...validCreateDirectory, extra: true }],
    [validCreateDirectory, 'extra'],
  ]) {
    expect(await enqueueCreateDirectory(event, ...args)).toEqual({
      ok: false,
      code: 'InvalidArgument',
    });
  }
  expect(getTasks).not.toHaveBeenCalled();
  expect(getBrowser).not.toHaveBeenCalled();

  expect(await enqueueCreateDirectory(event, validCreateDirectory)).toEqual({
    ok: true,
    value: true,
  });
  await vi.waitFor(() =>
    expect(createDirectory).toHaveBeenCalledExactlyOnceWith({ parent, name: 'projects' }),
  );
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
  const request = { parent, entries: [entry], directoryPath: '/disk' };

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
  const get = handlers.get(channels.getSetting)!;
  expect(await get(event, 'downloads.directory', 'unexpected')).toEqual({
    ok: false,
    code: 'InvalidArgument',
  });
  expect(getPreferences).not.toHaveBeenCalled();
  expect(await get(event, 'downloads.directory')).toEqual({
    ok: true,
    value: 'system-downloads',
  });
  expect(getBrowser).not.toHaveBeenCalled();
  await expect(get({ ...event, sender: {} }, 'downloads.directory')).rejects.toThrow(
    'Untrusted IPC sender',
  );
});

it('uploads the selected file with speed reporting, pause and resume in the task queue', async () => {
  const { event, browser, parent, entry, send } = setup();
  const upload = handlers.get(channels.uploadFileTask)!;
  const remoteParent = { ...parent, connectionId: '5e45885a-89f0-462e-9821-7195cba174e5' };
  const request = { parent: remoteParent, directoryPath: '/Drive' };
  const target = vi.spyOn(browser.uploads, 'validateDestination').mockResolvedValue(undefined);
  const uploaded = { ...entry, ref: { ...remoteParent, locator: 'uploaded-file' } };
  const run = vi
    .fn<WriteExecution['run']>()
    .mockImplementationOnce(async ({ pauseSignal, onBytesSent, onProgress }) => {
      const interrupted = new Promise<never>((_, reject) => {
        pauseSignal!.addEventListener('abort', () => reject(new StorageError('Cancelled')), {
          once: true,
        });
      });
      onBytesSent?.(4);
      onProgress?.({ confirmedBytes: 3, processedBytes: 4, totalBytes: 7 });
      return interrupted;
    })
    .mockResolvedValueOnce(uploaded);
  const write = vi.spyOn(browser, 'prepareUpload').mockReturnValue({ run });
  const snapshot = () => handlers.get(channels.getTaskSnapshot)!(event);

  expect(await upload(event, { ...request, path: 'D:\\other.txt' })).toEqual({
    ok: false,
    code: 'InvalidArgument',
  });
  await expect(upload({ ...event, sender: {} }, request)).rejects.toThrow('Untrusted IPC sender');
  expect(picker).not.toHaveBeenCalled();

  picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await upload(event, request)).toEqual({ ok: true, value: undefined });
  expect(write).not.toHaveBeenCalled();

  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-ipc-'));
  const path = join(temporary.path, entry.name);
  await writeFile(path, 'content');
  picker.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
  expect(await upload(event, request)).toEqual({ ok: true, value: undefined });
  expect(target).toHaveBeenLastCalledWith(remoteParent, undefined);
  await vi.waitFor(async () =>
    expect(await snapshot()).toMatchObject({
      value: {
        tasks: [
          {
            id: 1,
            status: 'running',
            controls: { canPause: true },
            progress: { completed: 3, bytesPerSecond: expect.any(Number) },
          },
        ],
      },
    }),
  );
  expect(write).toHaveBeenCalledExactlyOnceWith(remoteParent, entry.name, expect.anything());
  await vi.waitFor(async () => {
    const result = (await snapshot()) as {
      value: { tasks: [{ progress: { bytesPerSecond: number } }] };
    };
    expect(result.value.tasks[0].progress.bytesPerSecond).toBeGreaterThan(0);
  });
  expect(await handlers.get(channels.pauseTask)!(event, 1)).toEqual({ ok: true, value: undefined });
  await vi.waitFor(async () =>
    expect(await snapshot()).toMatchObject({
      value: {
        tasks: [
          {
            id: 1,
            status: 'paused',
            controls: { canResume: true },
            progress: { completed: 3 },
          },
        ],
      },
    }),
  );
  expect(await handlers.get(channels.resumeTask)!(event, 1)).toEqual({
    ok: true,
    value: undefined,
  });
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith(channels.taskEvent, {
      type: 'directory-changed',
      change: { kind: 'added', parent: remoteParent, entry: uploaded },
    }),
  );
  const settled = await snapshot();
  expect(settled).toMatchObject({
    ok: true,
    value: {
      tasks: [
        {
          status: 'completed',
          request: { type: 'upload', input: { ...request, name: entry.name } },
        },
      ],
    },
  });
  expect(JSON.stringify(settled)).not.toContain(JSON.stringify(path));
  expect(run).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledTimes(1);
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

it('pauses an upload on retryable failure and resumes the existing write session', async () => {
  const { event, browser, parent, services, send } = setup();
  const taskService = new StorageTaskService(browser);
  vi.spyOn(services.tasks, 'get').mockResolvedValue(taskService);
  const target = vi.spyOn(browser.uploads, 'validateDestination').mockResolvedValue(undefined);
  const remoteParent = { ...parent, connectionId: '5e45885a-89f0-462e-9821-7195cba174e5' };
  const entry = {
    ref: { ...remoteParent, locator: 'uploaded-retry' },
    name: 'retry.bin',
    kind: 'file' as const,
    size: 7,
    capabilities: {},
  };
  const run = vi
    .fn()
    .mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.({ confirmedBytes: 3, processedBytes: 4, totalBytes: 7 });
      throw new StorageError('NetworkError', { retryHint: 'safe' });
    })
    .mockResolvedValueOnce(entry);
  const prepare = vi.spyOn(browser, 'prepareUpload').mockReturnValue({ run });

  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-retry-'));
  const path = join(temporary.path, entry.name);
  await writeFile(path, 'content');
  picker.mockResolvedValueOnce({ canceled: false, filePaths: [path] });

  expect(
    await handlers.get(channels.uploadFileTask)!(event, {
      parent: remoteParent,
      directoryPath: 'My Drive',
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(target).toHaveBeenCalledWith(remoteParent, undefined);
  const snapshot = () => handlers.get(channels.getTaskSnapshot)!(event);
  await vi.waitFor(async () =>
    expect(await snapshot()).toMatchObject({
      value: {
        tasks: [
          {
            id: 1,
            status: 'paused',
            failure: { code: 'NetworkError' },
            controls: { canResume: true, canCancel: true },
            progress: { completed: 3, total: 7 },
          },
        ],
      },
    }),
  );
  expect(await handlers.get(channels.resumeTask)!(event, 1)).toEqual({
    ok: true,
    value: undefined,
  });
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith(channels.taskEvent, {
      type: 'directory-changed',
      change: { kind: 'added', parent: remoteParent, entry },
    }),
  );
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(2);
  await taskService.dispose();
});

it('requires folder creation support for a folder upload destination', async () => {
  const { event, browser, parent } = setup();
  const uploadFolder = handlers.get(channels.uploadFolderTask)!;
  const remoteParent = { ...parent, connectionId: '5e45885a-89f0-462e-9821-7195cba174e5' };
  const target = vi.spyOn(browser.uploads, 'validateDestination').mockResolvedValue(undefined);
  picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });

  expect(await uploadFolder(event, { parent: remoteParent, directoryPath: '/Drive' })).toEqual({
    ok: true,
    value: undefined,
  });
  expect(target).toHaveBeenLastCalledWith(remoteParent, true);
});

it('validates and uploads dropped files, folders, and mixed selections without opening a picker', async () => {
  const { event, browser, parent } = setup();
  const uploadPaths = handlers.get(channels.uploadPathsTask)!;
  const remoteParent = { ...parent, connectionId: '5e45885a-89f0-462e-9821-7195cba174e5' };
  const target = vi.spyOn(browser.uploads, 'validateDestination').mockResolvedValue(undefined);
  const destination = (
    browser.uploads as unknown as {
      destination: {
        createDirectory: (request: { parent: typeof remoteParent; name: string }) => Promise<Entry>;
      };
    }
  ).destination;
  const createDirectory = vi.spyOn(destination, 'createDirectory').mockResolvedValue({
    ref: { ...remoteParent, locator: 'created-dir' },
    name: 'docs',
    kind: 'directory',
    capabilities: { write: { support: 'supported' }, createDirectory: { support: 'supported' } },
  });
  const write = vi.spyOn(browser, 'prepareUpload').mockImplementation((targetParent, name) => ({
    run: vi.fn<WriteExecution['run']>(async () => ({
      ref: { ...targetParent, locator: `uploaded-${name}` },
      name,
      kind: 'file',
      capabilities: {},
    })),
  }));
  const snapshot = () => handlers.get(channels.getTaskSnapshot)!(event);

  expect(
    await uploadPaths(event, { parent: remoteParent, directoryPath: '/Drive', paths: [] }),
  ).toEqual({
    ok: false,
    code: 'InvalidArgument',
  });
  await expect(
    uploadPaths(
      { ...event, sender: {} },
      { parent: remoteParent, directoryPath: '/Drive', paths: ['D:\\a.txt'] },
    ),
  ).rejects.toThrow('Untrusted IPC sender');

  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-drop-ipc-'));
  const singleFile = join(temporary.path, 'cover.txt');
  const folder = join(temporary.path, 'docs');
  await writeFile(singleFile, 'cover');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'guide.txt'), 'guide');

  expect(
    await uploadPaths(event, {
      parent: remoteParent,
      directoryPath: '/Drive',
      paths: [singleFile],
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(target).toHaveBeenLastCalledWith(remoteParent, false);

  expect(
    await uploadPaths(event, {
      parent: remoteParent,
      directoryPath: '/Drive',
      paths: [singleFile, folder],
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(target).toHaveBeenLastCalledWith(remoteParent, true);
  expect(picker).not.toHaveBeenCalled();

  await vi.waitFor(async () =>
    expect(await snapshot()).toMatchObject({
      value: {
        groups: [{ state: { phase: 'settled', outcome: 'completed' } }],
      },
    }),
  );
  expect(createDirectory).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(3);
});
