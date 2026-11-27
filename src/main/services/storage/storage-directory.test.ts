import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { accountFixture } from '@main/accounts/providers/google-drive/testing/fixtures';
import { StorageAccess } from '@main/storage';
import { localConnectionId } from '@shared/storage-browser';
import { createGoogleDriveStorageProvider } from './providers/google-drive-storage-provider';
import { createLocalStorageProvider } from './providers/local-storage-provider';
import { StorageConnectionManager } from './storage-connections';
import { StorageEntryOperations } from './storage-entry-operations';
import { StoragePreferences } from './storage-preferences';
import { createStoredSpaceValidator } from './storage-provider';
import { StorageSpaceCatalog } from './storage-spaces';

function memorySnapshotStore() {
  let saved: unknown;
  return {
    read: () => saved,
    write(snapshot: unknown) {
      saved = structuredClone(snapshot);
    },
  };
}

function createOperations(
  localVolumes: () => Promise<string[]>,
  getAccounts: () => Promise<ReturnType<typeof accountFixture>['runtime']>,
) {
  const providers = [createLocalStorageProvider(localVolumes), createGoogleDriveStorageProvider()];
  const preferences = new StoragePreferences(memorySnapshotStore(), {
    validateSpace: createStoredSpaceValidator(providers),
  });
  const connections = new StorageConnectionManager(getAccounts, { event() {} }, providers);
  const storage = new StorageAccess(connections.registry);
  const spaces = new StorageSpaceCatalog(preferences, storage, connections);
  const operations = new StorageEntryOperations({ storage, connections, spaces });
  return {
    operations,
    spaces,
    dispose: () => connections.dispose(),
  };
}

it('provides directory-scoped operations, child handles, and local transfer inspection', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-storage-dir-'));
  await mkdir(join(temporary.path, 'src'));
  await mkdir(join(temporary.path, 'src', 'nested'));
  await writeFile(join(temporary.path, 'src', 'note.txt'), 'hello');

  const { runtime } = accountFixture();
  const { operations, spaces, dispose } = createOperations(
    async () => [temporary.path],
    async () => runtime,
  );
  try {
    const [choice] = await spaces.listSpaces(localConnectionId);
    if (!choice) throw new Error('Expected a local space');
    const rootDir = operations.directory(choice.space.root);

    expect(await rootDir.semantics()).toEqual(choice.space.semantics);
    expect((await rootDir.stat()).kind).toBe('directory');
    expect((await rootDir.capabilities()).list?.support).toBe('supported');

    const { entry: createdEntry, directory: dstDir } = await rootDir.createDirectory('dst');
    expect(createdEntry.kind).toBe('directory');
    expect(dstDir.ref).toEqual(createdEntry.ref);

    const srcDir = rootDir.child({ ...choice.space.root, locator: 'src' });
    const nestedDir = srcDir.child({ ...choice.space.root, locator: 'src/nested' });
    const noteFile = srcDir.file({ ...choice.space.root, locator: 'src/note.txt' });
    expect((await noteFile.stat()).name).toBe('note.txt');
    expect((await operations.file(noteFile.ref).stat()).size).toBe(5);
    expect(() =>
      rootDir.child({ connectionId: localConnectionId, spaceId: 'other-space', locator: '.' }),
    ).toThrow(expect.objectContaining({ code: 'InvalidArgument' }));
    expect(() =>
      rootDir.file({ connectionId: localConnectionId, spaceId: 'other-space', locator: 'a.txt' }),
    ).toThrow(expect.objectContaining({ code: 'InvalidArgument' }));

    expect(
      await operations.inspectTransfer(
        nestedDir.ref,
        [{ ref: srcDir.ref, kind: 'directory' }],
        'copy',
      ),
    ).toEqual({ selfContained: true, moveStrategy: 'native' });

    expect(
      await operations.inspectTransfer(
        dstDir.ref,
        [{ ref: srcDir.ref, kind: 'directory' }],
        'move',
      ),
    ).toEqual({
      selfContained: false,
      moveStrategy: 'native',
    });

    const copied = await dstDir.copyEntry(
      { ...choice.space.root, locator: 'src/note.txt' },
      'copied.txt',
    );
    expect(copied.name).toBe('copied.txt');

    const renamed = await operations.renameEntry(copied.ref, 'renamed.txt');
    expect(renamed.name).toBe('renamed.txt');

    const moved = await rootDir.moveEntry(renamed.ref, 'moved.txt');
    expect(moved.ref.locator).toBe('moved.txt');

    await operations.deleteEntry(moved.ref);
    expect((await dstDir.list()).entries).toEqual([]);
  } finally {
    await dispose();
    await runtime.dispose();
  }
});

it('rejects operations on unbrowsable spaces and cross-connection transfer inspection', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-storage-dir-guard-'));
  const { runtime } = accountFixture();
  const { operations, dispose } = createOperations(
    async () => [temporary.path],
    async () => runtime,
  );
  try {
    const unknownDir = operations.directory({
      connectionId: localConnectionId,
      spaceId: 'unknown-space',
      locator: '.',
    });
    await expect(unknownDir.stat()).rejects.toMatchObject({ code: 'NotFound' });
    await expect(unknownDir.list()).rejects.toMatchObject({ code: 'NotFound' });
    await expect(
      operations.inspectTransfer(
        unknownDir.ref,
        [{ ref: { connectionId: 'other-conn', spaceId: 's', locator: 'a' }, kind: 'file' }],
        'copy',
      ),
    ).rejects.toMatchObject({ code: 'InvalidArgument' });
  } finally {
    await dispose();
    await runtime.dispose();
  }
});
