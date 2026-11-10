import { mkdir, mkdtempDisposable, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
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
  await writeFile(join(outside, 'ignored.txt'), 'outside the saved folder');
  await mkdir(join(root, 'nested'));
  const file = join(root, 'file.txt');
  const modifiedAt = new Date('2026-01-02T03:04:06Z');
  await writeFile(file, 'saved file');
  await utimes(file, modifiedAt, modifiedAt);
  await symlink(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');

  const snapshotStore = memorySnapshotStore();
  snapshotStore.write({
    version: 2,
    folders: [],
    connections: [{ id: localConnectionId, discovered: [] }],
  });
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
    expect(await browser.listSpaces(localConnectionId)).toEqual([]);
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
    expect(await restored.listSpaces(localConnectionId)).toEqual([{ space, available: true }]);
    const page = await restored.listDirectory(space.root);
    expect(page.entries).toMatchObject([
      {
        name: 'file.txt',
        kind: 'file',
        displayPath: join(await realpath(root), 'file.txt'),
        size: 10,
        modifiedAt: modifiedAt.toISOString(),
      },
      { name: 'nested', kind: 'directory', modifiedAt: expect.any(String) },
      { name: 'redirect', kind: 'link' },
    ]);
    const folder = page.entries.find(({ name }) => name === 'nested');
    if (!folder) throw new Error('Expected the nested folder');
    expect(await restored.listDirectory(folder.ref)).toEqual({ entries: [] });
    expect(await restored.measureDirectorySize('size', [space.root])).toBe(10);
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

it('lists a local directory beyond the default page size in one response', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-storage-'));
  const names = Array.from(
    { length: 101 },
    (_, index) => `file-${String(index).padStart(3, '0')}.txt`,
  );
  await Promise.all(names.map((name) => writeFile(join(temporary.path, name), '')));

  const { runtime } = accountFixture();
  const browser = new StorageBrowser(
    new StoragePreferences(memorySnapshotStore()),
    async () => runtime,
    { event() {} },
  );
  try {
    const space = await browser.addLocalFolder(temporary.path);
    const page = await browser.listDirectory(space.root);
    expect(page.entries.map(({ name }) => name)).toEqual(names);
    expect(page.nextCursor).toBeUndefined();
  } finally {
    await browser.dispose();
    await runtime.dispose();
  }
});

it('persists discovered spaces separately from legacy selections and refreshes them explicitly', async () => {
  const snapshotStore = memorySnapshotStore();
  const { runtime } = accountFixture();
  const request = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      drives: [
        { id: 'team', name: 'Team' },
        { id: 'archive', name: 'Archive' },
      ],
    }),
  );
  vi.stubGlobal('fetch', request);

  function openBrowser() {
    return new StorageBrowser(new StoragePreferences(snapshotStore), async () => runtime, {
      event() {},
    });
  }

  let browser: StorageBrowser | undefined;
  try {
    const account = await runtime.accounts.add('google-drive', { method: 'browser' });
    const saved = {
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
    };
    snapshotStore.write(saved);
    browser = openBrowser();
    const [choices, concurrentChoices] = await Promise.all([
      browser.listSpaces(account.id),
      browser.listSpaces(account.id),
    ]);
    const expectedSpaces = choices.slice(0, 2).map(({ space }) => space);
    expect(choices.map(({ space }) => space.id)).toEqual([
      'my-drive',
      'shared:team',
      'shared:archive',
    ]);
    expect(concurrentChoices).toEqual(choices);
    expect(request).toHaveBeenCalledTimes(1);
    expect(snapshotStore.read()).toEqual({
      ...saved,
      connections: [{ ...saved.connections[0], discovered: choices.map(({ space }) => space) }],
    });
    await browser.dispose();

    request.mockReset().mockRejectedValue(new TypeError('offline'));
    browser = openBrowser();
    expect(await browser.listConnections()).toMatchObject([
      { id: account.id, spaces: expectedSpaces },
    ]);
    expect(await browser.listSpaces(account.id)).toEqual(choices);
    expect(request).not.toHaveBeenCalled();
    await expect(browser.listSpaces(account.id, true)).rejects.toMatchObject({
      code: 'NetworkError',
    });
    expect(await browser.listSpaces(account.id)).toEqual(choices);
    expect(request).toHaveBeenCalledTimes(1);

    request.mockResolvedValueOnce(Response.json({ drives: [{ id: 'new', name: 'New' }] }));
    const refreshed = await browser.listSpaces(account.id, true);
    expect(refreshed.map(({ space, available }) => [space.id, available])).toEqual([
      ['my-drive', true],
      ['shared:new', true],
      ['shared:team', false],
    ]);
    await browser.saveSpaces(account.id, []);
    await browser.dispose();

    browser = openBrowser();
    expect(await browser.listConnections()).toMatchObject([{ id: account.id, spaces: [] }]);
    expect(await browser.listSpaces(account.id)).toEqual(refreshed.slice(0, 2));
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
    await browser?.dispose();
    await runtime.dispose();
  }
});
