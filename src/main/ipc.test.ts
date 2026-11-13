import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';
import { channels } from '../shared/contracts';
import { defaultLanguageSettings } from '../shared/language';
import { registerIpcHandlers } from './ipc';
import { ApplicationServices } from './services/application-services';
import { StorageBrowser } from './services/storage-browser';
import { StoragePreferences } from './services/storage-preferences';
import { StorageError } from './storage';

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
  return { handler, event, ref, getBrowser, deleteEntry };
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
