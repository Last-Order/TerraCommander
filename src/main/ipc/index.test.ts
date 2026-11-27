import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, OpenDialogReturnValue } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { channels } from '@shared/contracts';
import { defaultLanguageSettings, type LanguagePreference } from '@shared/language';
import type { Entry } from '@shared/storage';
import { defaultTransferConcurrency } from '@shared/tasks';
import { AccountError } from '../accounts/core/errors';
import { ApplicationServices } from '../services/application-services';
import { DownloadPreferences } from '../services/preferences/download-preferences';
import { createGoogleDriveStorageProvider } from '../services/storage/providers/google-drive-storage-provider';
import { createLocalStorageProvider } from '../services/storage/providers/local-storage-provider';
import { StoragePreferences } from '../services/storage/storage-preferences';
import { createStorageServices } from '../services/storage/storage-services';
import { StorageTaskService } from '../services/tasks/storage-task-service';
import { TransferPreferences } from '../services/tasks/transfer-preferences';
import { StorageError, type WriteExecution } from '../storage';
import { registerIpcHandlers } from './';

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

function setup(localVolumes?: () => Promise<string[]>) {
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
  const storage = createStorageServices({
    preferences,
    getAccounts: async () => {
      throw new Error('Accounts must not be initialized.');
    },
    logger: { event() {} },
    providers: [createLocalStorageProvider(localVolumes), createGoogleDriveStorageProvider()],
    localVolumes,
  });
  const services = new ApplicationServices({ whenReady: async () => {} });
  activeServices.push(services);
  const transferPreferences = new TransferPreferences({ read: () => undefined, write() {} });
  vi.spyOn(services.transferPreferences, 'get').mockResolvedValue(transferPreferences);
  const getBrowser = vi.spyOn(services.storage, 'get').mockResolvedValue(storage);
  const createDirectory = vi.spyOn(storage.operations, 'createDirectory').mockResolvedValue({
    ref: { connectionId: 'local', spaceId: 'disk', locator: 'projects' },
    name: 'projects',
    kind: 'directory',
    capabilities: { list: { support: 'supported' } },
  });
  const deleteEntry = vi.spyOn(storage.operations, 'deleteEntry').mockResolvedValue(undefined);
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
    storage,
    getBrowser,
    createDirectory,
    deleteEntry,
    services,
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
  expect(await getSetting(event, 'transfers.concurrencyLimit')).toEqual({
    ok: true,
    value: defaultTransferConcurrency,
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
    [{ ...validDelete, entries: [{ ...entry, ref: { ...entry.ref, connectionId: 'bad id!' } }] }],
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
    [{ parent: { ...parent, connectionId: 'bad id!' }, name: 'projects', directoryPath: '/disk' }],
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
    { ...event, senderFrame: { url: event.senderFrame.url } },
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

it('transfers a file picked via local dialog with progress, pause, and resume in the unified queue', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-transfer-ipc-'));
  const { event, storage, parent, entry, send } = setup(async () => [temporary.path]);
  const transferDialog = handlers.get(channels.transferFromLocalDialogTask)!;
  const remoteParent = { ...parent, connectionId: '5e45885a-89f0-462e-9821-7195cba174e5' };
  const request = {
    targetParent: remoteParent,
    targetDirectoryPath: '/Drive',
    kind: 'file' as const,
  };
  const remoteDirEntry: Entry = {
    ref: remoteParent,
    name: 'Drive',
    kind: 'directory',
    capabilities: {
      write: { support: 'supported' },
      pausableWrite: { support: 'supported' },
      createDirectory: { support: 'supported' },
    },
  };
  const originalStat = storage.operations.statEntry.bind(storage.operations);
  vi.spyOn(storage.operations, 'statEntry').mockImplementation((ref, ctx) =>
    ref.connectionId === remoteParent.connectionId
      ? Promise.resolve(remoteDirEntry)
      : originalStat(ref, ctx),
  );
  vi.spyOn(storage.operations, 'spaceCapabilities').mockResolvedValue(remoteDirEntry.capabilities);
  vi.spyOn(storage.operations, 'spaceSemantics').mockResolvedValue({ allowsDuplicateNames: true });
  vi.spyOn(storage.operations, 'resolveProvider').mockImplementation(async (id) =>
    id === 'local' ? 'local' : 'google-drive',
  );
  vi.spyOn(storage.operations, 'validateEntryName').mockResolvedValue(true);
  vi.spyOn(storage.operations, 'openDirectoryScope').mockResolvedValue({
    root: remoteParent,
    assertValid: async () => {},
    ensureDirectory: async (_parent, name) => ({
      entry: {
        ref: { ...remoteParent, locator: name },
        name,
        kind: 'directory',
        capabilities: remoteDirEntry.capabilities,
      },
      created: true,
    }),
    cleanupCreated: async () => {},
  });
  vi.spyOn(storage.operations, 'inspectCrossConnectionTransfer').mockResolvedValue({
    selfContained: false,
  });
  vi.spyOn(storage.operations, 'canonicalEntryKey').mockImplementation(
    async (ref) => `${ref.connectionId}:${ref.spaceId}:${ref.locator}`,
  );
  vi.spyOn(storage.operations, 'targetLockKeys').mockResolvedValue({
    exclusive: ['slot:remote/notes.txt'],
    shared: ['remote'],
  });

  const uploaded: Entry = { ...entry, ref: { ...remoteParent, locator: 'uploaded-file' } };
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
  const prepareWrite = vi.spyOn(storage.operations, 'prepareWrite').mockReturnValue({ run });
  const snapshot = () => handlers.get(channels.getTaskSnapshot)!(event);

  expect(await transferDialog(event, { ...request, extra: true })).toEqual({
    ok: false,
    code: 'InvalidArgument',
  });
  await expect(transferDialog({ ...event, sender: {} }, request)).rejects.toThrow(
    'Untrusted IPC sender',
  );
  expect(picker).not.toHaveBeenCalled();

  picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await transferDialog(event, request)).toEqual({
    ok: true,
    value: { status: 'started' },
  });
  expect(prepareWrite).not.toHaveBeenCalled();

  const filePath = join(temporary.path, entry.name);
  await writeFile(filePath, 'content');
  picker.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
  expect(await transferDialog(event, request)).toEqual({
    ok: true,
    value: { status: 'started' },
  });

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
          request: {
            type: 'transfer',
            input: {
              mode: 'copy',
              sourceProvider: 'local',
              targetProvider: 'google-drive',
              targetName: entry.name,
            },
          },
        },
      ],
    },
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(prepareWrite).toHaveBeenCalledTimes(1);
});

it('validates transfer IPC inputs and task control channels strictly before initializing task services', async () => {
  const { event, entry, parent, services, getBrowser } = setup();
  const getTasks = vi.spyOn(services.tasks, 'get');
  const id = '5e45885a-89f0-462e-9821-7195cba174e5';
  const remoteParent = { ...parent, connectionId: id };
  const remoteEntry = { ...entry, ref: { ...entry.ref, connectionId: id } };

  const transferToLocal = handlers.get(channels.transferToLocalDirectoryTask)!;
  const validToLocal = {
    sourceParent: remoteParent,
    sourceDirectoryPath: '/Drive',
    entries: [remoteEntry],
    directory: 'D:\\Downloads',
  };
  for (const invalid of [
    null,
    { ...validToLocal, entries: [] },
    { ...validToLocal, replace: true },
    { ...validToLocal, directory: 'D:\\Bad\0Path' },
  ]) {
    expect(await transferToLocal(event, invalid)).toEqual({ ok: false, code: 'InvalidArgument' });
  }
  await expect(transferToLocal({ ...event, sender: {} }, validToLocal)).rejects.toThrow(
    'Untrusted IPC sender',
  );

  for (const channel of [channels.confirmTransferTask, channels.cancelTransferConfirmation]) {
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
  for (const args of [[], ['s3'], ['local', 'extra'], ['google-drive', 'extra']]) {
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
  const { event, storage, services, emitWebContents } = setup();
  const taskService = new StorageTaskService({
    operations: storage.operations,
    transfers: storage.transfers,
    localPathBridge: storage.localPathBridge,
  });
  vi.spyOn(services.tasks, 'get').mockResolvedValue(taskService);
  const cancelOwner = vi.spyOn(storage.browser, 'cancelOwnerOperations');
  const cancelAuth = vi.spyOn(storage.browser, 'cancelAuthorization');
  const cancelTaskOwner = vi.spyOn(taskService, 'cancelOwnerOperations');

  await handlers.get(channels.listConnections)!(event);
  await handlers.get(channels.getTaskSnapshot)!(event);

  emitWebContents('render-process-gone');
  expect(cancelOwner).toHaveBeenCalledTimes(1);
  expect(cancelOwner).toHaveBeenLastCalledWith(1);
  expect(cancelAuth).toHaveBeenCalledTimes(1);
  expect(cancelTaskOwner).toHaveBeenCalledTimes(1);
  expect(cancelTaskOwner).toHaveBeenLastCalledWith(1);

  emitWebContents('did-start-navigation', undefined, 'about:blank', false, false);
  expect(cancelOwner).toHaveBeenCalledTimes(1);
  expect(cancelTaskOwner).toHaveBeenCalledTimes(1);

  emitWebContents('did-start-navigation', undefined, 'https://example.com', false, true);
  expect(cancelOwner).toHaveBeenCalledTimes(2);
  expect(cancelTaskOwner).toHaveBeenCalledTimes(2);

  await taskService.dispose();
});

it('validates dropped local paths and forwards them to the owning task session for any storage target', async () => {
  const { event, parent, services } = setup();
  const transferFromLocalPaths = handlers.get(channels.transferFromLocalPathsTask)!;
  const getTasks = vi.spyOn(services.tasks, 'get');
  const spy = vi
    .spyOn(StorageTaskService.prototype, 'transferFromLocalPaths')
    .mockResolvedValue({ status: 'started' });
  const request = {
    targetParent: parent,
    targetDirectoryPath: 'D:\\Target',
    paths: ['D:\\cover.txt', 'D:\\docs'],
  };

  expect(await transferFromLocalPaths(event, { ...request, paths: [] })).toEqual({
    ok: false,
    code: 'InvalidArgument',
  });
  await expect(transferFromLocalPaths({ ...event, sender: {} }, request)).rejects.toThrow(
    'Untrusted IPC sender',
  );
  expect(getTasks).not.toHaveBeenCalled();

  expect(await transferFromLocalPaths(event, request)).toEqual({
    ok: true,
    value: { status: 'started' },
  });
  expect(spy).toHaveBeenCalledExactlyOnceWith(event.sender.id, request);
  expect(picker).not.toHaveBeenCalled();
});
