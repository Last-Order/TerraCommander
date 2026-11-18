import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';
import { channels } from '../shared/contracts';
import { defaultLanguageSettings } from '../shared/language';
import { registerIpcHandlers } from './ipc';
import { ApplicationServices } from './services/application-services';
import { StorageBrowser } from './services/storage-browser';
import { StoragePreferences } from './services/storage-preferences';
import { StorageError } from './storage';
import { DownloadPreferences } from './services/download-preferences';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  app: {},
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    },
  },
}));

function setup() {
  const entryUrl = 'file:///D:/app/index.html';
  const webContents = { mainFrame: { url: entryUrl } };
  const window = { webContents } as unknown as BrowserWindow;
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const browser = new StorageBrowser(
    new StoragePreferences({ read: () => undefined, write() {} }),
    async () => {
      throw new Error('Accounts must not be initialized.');
    },
    { event() {} },
  );
  const services = new ApplicationServices({ whenReady: async () => {} });
  const getBrowser = vi.spyOn(services.storageBrowser, 'get').mockResolvedValue(browser);
  const deleteEntry = vi.spyOn(browser, 'deleteEntry').mockResolvedValue(undefined);
  registerIpcHandlers(() => window, entryUrl, services, {
    get: () => defaultLanguageSettings,
    set: () => null,
  });
  const handler = handlers.get(channels.deleteEntry);
  if (!handler) throw new Error('Missing deletion handler');
  const ref = { connectionId: 'local', spaceId: 'disk', locator: 'notes.txt' };
  return { handler, event, ref, getBrowser, deleteEntry, services };
}

it('only forwards a validated single entry and rejects renderer-supplied deletion modes', async () => {
  const { handler, event, ref, getBrowser, deleteEntry } = setup();
  for (const args of [
    [],
    [null],
    [{ ...ref, connectionId: 'invalid' }],
    [ref, 'trash'],
    [ref, 'permanent'],
    [ref, ref],
  ]) {
    expect(await handler(event, ...args)).toEqual({ ok: false, code: 'InvalidArgument' });
  }
  expect(getBrowser).not.toHaveBeenCalled();
  expect(await handler(event, ref)).toEqual({ ok: true, value: undefined });
  expect(deleteEntry).toHaveBeenCalledExactlyOnceWith(ref);
});

it('rejects untrusted senders before initializing deletion services', async () => {
  const { handler, event, ref, getBrowser } = setup();
  for (const untrusted of [
    { ...event, sender: {} },
    { ...event, senderFrame: { url: 'https://example.com' } },
  ]) {
    await expect(handler(untrusted, ref)).rejects.toThrow('Untrusted IPC sender');
  }
  event.senderFrame.url = 'https://example.com';
  await expect(handler(event, ref)).rejects.toThrow('Untrusted IPC sender');
  expect(getBrowser).not.toHaveBeenCalled();
});

it('returns safe deletion error codes without provider details', async () => {
  const { handler, event, ref, deleteEntry } = setup();
  deleteEntry.mockRejectedValueOnce(new StorageError('PermissionDenied'));
  expect(await handler(event, ref)).toEqual({ ok: false, code: 'PermissionDenied' });
});

it('reads download defaults without loading storage or accounts and validates download arguments', async () => {
  const { services, event, ref, getBrowser } = setup();
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
    value: {
      directory: 'system-downloads',
    },
  });
  const prepare = handlers.get(channels.prepareDownload)!;
  for (const request of [
    null,
    { ref, directory: 'D:\\Downloads', expectedName: 'file', replace: false },
    {
      ref: { ...ref, connectionId: '5e45885a-89f0-462e-9821-7195cba174e5' },
      directory: 'D:\\Downloads',
      expectedName: 'file',
      name: 'custom-name',
      replace: false,
    },
  ]) {
    expect(await prepare(event, request)).toEqual({ ok: false, code: 'InvalidArgument' });
  }
  expect(getBrowser).not.toHaveBeenCalled();
  await expect(get({ ...event, sender: {} })).rejects.toThrow('Untrusted IPC sender');
});

it('validates download run attempts and pause requests before loading transfer services', async () => {
  const { event, getBrowser } = setup();
  const id = '5e45885a-89f0-462e-9821-7195cba174e5';
  const run = handlers.get(channels.runDownload)!;
  const pause = handlers.get(channels.pauseDownload)!;
  for (const args of [[], [id], [id, 'invalid'], [id, id, 'unexpected']]) {
    expect(await run(event, ...args)).toEqual({ ok: false, code: 'InvalidArgument' });
  }
  for (const args of [[], ['invalid'], [id, 'unexpected']]) {
    expect(await pause(event, ...args)).toEqual({ ok: false, code: 'InvalidArgument' });
  }
  await expect(pause({ ...event, sender: {} }, id)).rejects.toThrow('Untrusted IPC sender');
  expect(getBrowser).not.toHaveBeenCalled();
});

it('validates batch inputs and every batch lifecycle request before loading services', async () => {
  const { event, getBrowser } = setup();
  const id = '5e45885a-89f0-462e-9821-7195cba174e5';
  const request = {
    directory: 'D:\\Downloads',
    entries: [
      { ref: { connectionId: id, spaceId: 'drive', locator: 'file' }, expectedName: 'file.txt' },
    ],
  };
  const prepare = handlers.get(channels.prepareDownloadBatch)!;
  for (const invalid of [
    null,
    { ...request, entries: [] },
    { ...request, replace: true },
    { ...request, entries: [{ ...request.entries[0], path: '../outside' }] },
  ])
    expect(await prepare(event, invalid)).toEqual({ ok: false, code: 'InvalidArgument' });
  for (const channel of [
    channels.confirmDownloadBatch,
    channels.finishDownloadBatch,
    channels.releaseDownloadBatch,
  ]) {
    const handler = handlers.get(channel)!;
    expect(await handler(event, 'invalid')).toEqual({ ok: false, code: 'InvalidArgument' });
    await expect(handler({ ...event, sender: {} }, id)).rejects.toThrow('Untrusted IPC sender');
  }
  const items = handlers.get(channels.discoverDownloadDirectory)!;
  for (const offset of [-1, 1.5, Infinity, '0'])
    expect(await items(event, id, 0, offset)).toEqual({ ok: false, code: 'InvalidArgument' });
  for (const channel of [channels.cancelDownloadBatchItem]) {
    const handler = handlers.get(channel)!;
    expect(await handler(event, id, -1)).toEqual({ ok: false, code: 'InvalidArgument' });
    await expect(handler({ ...event, sender: {} }, id, 0)).rejects.toThrow('Untrusted IPC sender');
  }
  for (const channel of [
    channels.resolveDownloadWork,
    channels.cancelDownloadWork,
    channels.releaseDownloadWork,
  ]) {
    const handler = handlers.get(channel)!;
    for (const ref of [
      null,
      { planId: 'invalid', itemId: 0 },
      { planId: id, itemId: -1 },
      { planId: id, itemId: 0, path: '../outside' },
    ])
      expect(await handler(event, ref)).toEqual({ ok: false, code: 'InvalidArgument' });
    await expect(handler({ ...event, sender: {} }, { planId: id, itemId: 0 })).rejects.toThrow(
      'Untrusted IPC sender',
    );
  }
  expect(getBrowser).not.toHaveBeenCalled();
});
