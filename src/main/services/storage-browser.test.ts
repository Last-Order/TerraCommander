import { mkdir, mkdtempDisposable, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { localConnectionId } from '../../shared/storage-browser';
import { accountFixture } from '../accounts/providers/google-drive/testing/fixtures';
import { createAccountServices } from '../accounts/runtime/account-services';
import { FakeAccountCipher, MemoryAccountStore } from '../accounts/testing/fixtures';
import { StorageBrowser } from './storage-browser';
import { StoragePreferences } from './storage-preferences';

function memorySnapshotStore() {
  let saved: unknown;
  return {
    read: () => saved,
    write(snapshot: unknown) {
      saved = structuredClone(snapshot);
    },
  };
}

it('restores a chosen folder and confines browsing to its saved root', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-storage-'));
  const root = join(temporary.path, 'saved');
  const outside = join(temporary.path, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, 'nested'));
  const file = join(root, 'file.txt');
  const modifiedAt = new Date('2026-01-02T03:04:06Z');
  await writeFile(file, 'saved file');
  await utimes(file, modifiedAt, modifiedAt);
  await symlink(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');

  const snapshotStore = memorySnapshotStore();
  const accounts = createAccountServices({
    store: new MemoryAccountStore(),
    cipher: new FakeAccountCipher(),
  });
  function openBrowser() {
    return new StorageBrowser(new StoragePreferences(snapshotStore), async () => accounts, {
      event() {},
    });
  }
  const browser = openBrowser();
  let space;
  try {
    expect(await browser.listConnections()).toEqual([]);
    space = await browser.addLocalFolder(root);
    await browser.saveSpaces(localConnectionId, [space.id]);
  } finally {
    await browser.dispose();
  }

  const restored = openBrowser();
  try {
    expect(await restored.listConnections()).toMatchObject([
      { id: localConnectionId, spaces: [space] },
    ]);
    const page = await restored.listDirectory(space.root);
    expect(page.entries).toMatchObject([
      { name: 'file.txt', kind: 'file', size: 10, modifiedAt: modifiedAt.toISOString() },
      { name: 'nested', kind: 'directory', modifiedAt: expect.any(String) },
      { name: 'redirect', kind: 'link' },
    ]);
    const folder = page.entries.find(({ name }) => name === 'nested');
    if (!folder) throw new Error('Expected the nested folder');
    expect(await restored.listDirectory(folder.ref)).toEqual({ entries: [] });
    await expect(restored.listDirectory({ ...space.root, locator: '..' })).rejects.toMatchObject({
      code: 'InvalidArgument',
    });
    await expect(
      restored.listDirectory({ ...space.root, locator: 'redirect' }),
    ).rejects.toMatchObject({ code: 'InvalidArgument' });
  } finally {
    await restored.dispose();
    await accounts.dispose();
  }
});

it('rebuilds My Drive, restores cached shared drives offline, and preserves an empty selection', async () => {
  const snapshotStore = memorySnapshotStore();
  const { runtime } = accountFixture();
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ drives: [{ id: 'team', name: 'Team' }] }));
  vi.stubGlobal('fetch', request);

  function openBrowser() {
    return new StorageBrowser(new StoragePreferences(snapshotStore), async () => runtime, {
      event() {},
    });
  }

  let browser = openBrowser();
  try {
    const account = await runtime.accounts.add('google-drive', { method: 'browser' });
    const choices = await browser.listSpaces(account.id);
    const expectedSpaces = choices.map(({ space }) => space);
    await browser.saveSpaces(account.id, ['my-drive', 'shared:team']);
    expect(snapshotStore.read()).toEqual({
      version: 2,
      folders: [],
      connections: [
        {
          id: account.id,
          spaces: [
            { id: 'my-drive' },
            { id: 'shared:team', cached: { name: 'Team', locator: 'team' } },
          ],
        },
      ],
    });
    await browser.dispose();

    request.mockReset().mockRejectedValue(new TypeError('offline'));
    browser = openBrowser();
    expect(await browser.listConnections()).toMatchObject([
      { id: account.id, spaces: expectedSpaces },
    ]);
    expect(request).not.toHaveBeenCalled();
    await expect(browser.listSpaces(account.id)).rejects.toMatchObject({ code: 'NetworkError' });
    expect(await browser.listConnections()).toMatchObject([
      { id: account.id, spaces: expectedSpaces },
    ]);
    await browser.saveSpaces(account.id, []);
    await browser.dispose();

    browser = openBrowser();
    expect(await browser.listConnections()).toMatchObject([{ id: account.id, spaces: [] }]);
  } finally {
    vi.unstubAllGlobals();
    await browser.dispose();
    await runtime.dispose();
  }
});
