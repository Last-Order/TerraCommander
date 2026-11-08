import { mkdir, mkdtempDisposable, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { localConnectionId } from '../../shared/storage-browser';
import { createAccountServices } from '../accounts/runtime/account-services';
import { FakeAccountCipher, MemoryAccountStore } from '../accounts/testing/fixtures';
import { StorageBrowser } from './storage-browser';
import { StoragePreferences } from './storage-preferences';

it('restores a chosen folder and confines browsing to its saved root', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-storage-'));
  const root = join(temporary.path, 'saved');
  const outside = join(temporary.path, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'file.txt'), 'saved file');
  await symlink(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');

  let saved: unknown;
  const snapshotStore = {
    read: () => saved,
    write: (snapshot: unknown) => {
      saved = structuredClone(snapshot);
    },
  };
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
    expect(page.entries.map(({ name, kind }) => [name, kind])).toEqual([
      ['file.txt', 'file'],
      ['nested', 'directory'],
      ['redirect', 'link'],
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
