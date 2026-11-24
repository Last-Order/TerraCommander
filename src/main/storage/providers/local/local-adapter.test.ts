import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AdapterRegistry, StorageAccess } from '../..';
import { localAdapterFactory, localFailure, localSpace } from './local-adapter';
import { createLocalPlatform } from './local-platform';

async function setup(path: string) {
  const registry = new AdapterRegistry({
    credentials: { async resolve() {} },
    logger: { event() {} },
  });
  registry.register(
    localAdapterFactory(
      () => [path],
      async () => [],
    ),
  );
  await registry.connect({ id: 'local', provider: 'local', configuration: {} });
  return {
    registry,
    storage: new StorageAccess(registry),
    root: localSpace('local', path).root,
  };
}

it('renames local files and folders and returns their new references', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-rename-'));
  await writeFile(join(temporary.path, 'before.txt'), 'preserved content');
  await mkdir(join(temporary.path, 'folder'));
  await writeFile(join(temporary.path, 'folder', 'child.txt'), 'child');
  const { registry, storage, root } = await setup(temporary.path);
  try {
    const before = { ...root, locator: 'before.txt' };
    const renamed = await storage.rename(before, '重命名.txt');
    expect(renamed).toMatchObject({
      name: '重命名.txt',
      ref: { ...root, locator: '重命名.txt' },
    });
    expect(await readFile(join(temporary.path, renamed.name), 'utf8')).toBe('preserved content');
    await expect(storage.stat(before)).rejects.toMatchObject({ code: 'NotFound' });
    const folder = await storage.rename({ ...root, locator: 'folder' }, 'renamed-folder');
    expect(folder.kind).toBe('directory');
    expect((await storage.list(folder.ref)).entries).toMatchObject([
      { name: 'child.txt', ref: { ...root, locator: 'renamed-folder/child.txt' } },
    ]);
    await storage.rename(renamed.ref, '重命名.TXT');
    expect(await readdir(temporary.path)).toContain('重命名.TXT');
  } finally {
    await registry.dispose();
  }
});

it('deletes a single file while protecting roots, folders and paths through links', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-delete-'));
  const saved = join(temporary.path, 'saved');
  const outside = join(temporary.path, 'outside');
  await mkdir(saved);
  await mkdir(outside);
  await mkdir(join(saved, 'folder'));
  await writeFile(join(saved, 'folder', 'nested.txt'), 'nested');
  await writeFile(join(saved, 'file.txt'), 'delete me');
  await writeFile(join(saved, 'keep.txt'), 'keep me');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(
    outside,
    join(saved, 'redirect'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const { registry, storage, root } = await setup(saved);
  try {
    const file = { ...root, locator: 'file.txt' };
    expect((await storage.stat(file)).capabilities.remove?.support).toBe('supported');
    await storage.remove(file);
    await expect(storage.stat(file)).rejects.toMatchObject({ code: 'NotFound' });
    await expect(storage.remove(root)).rejects.toMatchObject({ code: 'InvalidArgument' });
    await expect(storage.remove({ ...root, locator: '..' })).rejects.toMatchObject({
      code: 'InvalidArgument',
    });
    await storage.remove({ ...root, locator: 'folder' });
    await expect(storage.stat({ ...root, locator: 'folder' })).rejects.toMatchObject({
      code: 'NotFound',
    });
    await expect(storage.remove({ ...root, locator: 'redirect/secret.txt' })).rejects.toMatchObject(
      { code: 'NotFound' },
    );
    await storage.remove({ ...root, locator: 'redirect' });
    expect(await readdir(saved)).toEqual(['keep.txt']);
    expect(await readFile(join(saved, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
  } finally {
    await registry.dispose();
  }
});

it('rejects conflicting names, invalid names, root renames and traversal through links', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-rename-'));
  const saved = join(temporary.path, 'saved');
  const outside = join(temporary.path, 'outside');
  await mkdir(saved);
  await mkdir(outside);
  await writeFile(join(saved, 'source.txt'), 'source');
  await writeFile(join(saved, 'existing.txt'), 'existing');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(
    outside,
    join(saved, 'redirect'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const { registry, storage, root } = await setup(saved);
  try {
    const source = { ...root, locator: 'source.txt' };
    await expect(storage.rename(source, 'existing.txt')).rejects.toMatchObject({
      code: 'AlreadyExists',
    });
    const invalid = ['', ' ', '.', '..', '../escaped.txt', 'sub/file.txt', 'bad\0name'];
    if (process.platform === 'win32') invalid.push('CON.txt', 'bad:name', 'bad\\name', 'bad.');
    for (const name of invalid) {
      await expect(storage.rename(source, name)).rejects.toMatchObject({ code: 'InvalidArgument' });
    }
    await expect(storage.rename(root, 'moved')).rejects.toMatchObject({ code: 'InvalidArgument' });
    await expect(
      storage.rename({ ...root, locator: 'redirect/secret.txt' }, 'changed.txt'),
    ).rejects.toMatchObject({ code: 'NotFound' });
    expect(await readFile(join(saved, 'source.txt'), 'utf8')).toBe('source');
    expect(await readFile(join(saved, 'existing.txt'), 'utf8')).toBe('existing');
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
  } finally {
    await registry.dispose();
  }
});

it('reports scope-accurate capabilities and honors pre-aborted signals', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-local-caps-'));
  const file = join(temporary.path, 'item.txt');
  const folder = join(temporary.path, 'dir');
  await writeFile(file, 'hello');
  await mkdir(folder);
  const { registry, storage, root } = await setup(temporary.path);
  try {
    const spaceCaps = await storage.capabilities({
      kind: 'space',
      connectionId: 'local',
      spaceId: root.spaceId,
    });
    expect(spaceCaps).toMatchObject({
      list: { support: 'supported' },
      rename: { support: 'supported' },
      remove: { support: 'supported' },
      read: { support: 'unsupported' },
      write: { support: 'unsupported' },
    });

    const expectedDirWrite =
      process.platform === 'win32' ? { support: 'unknown' } : { support: 'supported' };

    const rootCaps = await storage.capabilities({ kind: 'entry', ref: root });
    expect(rootCaps).toEqual((await storage.stat(root)).capabilities);
    expect(rootCaps).toMatchObject({
      list: { support: 'supported' },
      write: expectedDirWrite,
      createDirectory: expectedDirWrite,
      rename: { support: 'unsupported' },
      remove: { support: 'unsupported' },
    });

    const fileRef = { ...root, locator: 'item.txt' };
    const fileCaps = await storage.capabilities({ kind: 'entry', ref: fileRef });
    expect(fileCaps).toEqual((await storage.stat(fileRef)).capabilities);
    expect(fileCaps).toMatchObject({
      list: { support: 'unsupported' },
      write: { support: 'unsupported' },
      createDirectory: { support: 'unsupported' },
      rename: { support: 'supported' },
      remove: { support: 'supported' },
    });

    const dirRef = { ...root, locator: 'dir' };
    const dirCaps = await storage.capabilities({ kind: 'entry', ref: dirRef });
    expect(dirCaps).toMatchObject({
      list: { support: 'supported' },
      write: expectedDirWrite,
      createDirectory: expectedDirWrite,
      rename: { support: 'supported' },
      remove: { support: 'supported' },
    });

    const listed = await storage.list(root);
    expect(listed.entries.find((entry) => entry.name === 'dir')?.capabilities).toEqual(dirCaps);
    expect(listed.entries.find((entry) => entry.name === 'item.txt')?.capabilities).toEqual(
      fileCaps,
    );

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await chmod(folder, 0o555);
      try {
        const readOnlyCaps = await storage.capabilities({ kind: 'entry', ref: dirRef });
        expect(readOnlyCaps).toMatchObject({
          write: { support: 'unsupported' },
          createDirectory: { support: 'unsupported' },
        });
        const listedReadOnly = await storage.list(root);
        expect(listedReadOnly.entries.find((entry) => entry.name === 'dir')?.capabilities).toEqual(
          readOnlyCaps,
        );
      } finally {
        await chmod(folder, 0o755);
      }
    }

    await expect(
      storage.capabilities(
        { kind: 'connection', connectionId: 'local' },
        {
          signal: AbortSignal.abort(),
        },
      ),
    ).rejects.toMatchObject({ code: 'Cancelled' });
  } finally {
    await registry.dispose();
  }
});

it('validates entry names and locator segments per platform', () => {
  const win = createLocalPlatform('win32');
  const posixPlatform = createLocalPlatform('darwin');

  for (const name of ['', ' ', '.', '..', 'a/b', 'bad\0name']) {
    expect(win.isValidEntryName(name)).toBe(false);
    expect(posixPlatform.isValidEntryName(name)).toBe(false);
  }

  for (const name of ['CON.txt', 'bad:name', 'bad\\name', 'bad.', 'bad ', 'a\x01b']) {
    expect(win.isValidEntryName(name)).toBe(false);
    expect(posixPlatform.isValidEntryName(name)).toBe(true);
  }

  expect(win.isValidLocatorSegment('a\\b')).toBe(false);
  expect(win.isValidLocatorSegment('bad:name')).toBe(false);
  expect(posixPlatform.isValidLocatorSegment('a\\b')).toBe(true);
  expect(posixPlatform.isValidLocatorSegment('bad:name')).toBe(true);

  expect(win.caseSensitive).toBe(false);
  expect(posixPlatform.caseSensitive).toBe(false);
  expect(createLocalPlatform('linux').caseSensitive).toBe(true);
});

it('reports space case sensitivity semantics from the local platform', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-local-semantics-'));
  for (const [platformName, expectedCaseSensitive] of [
    ['win32', false],
    ['darwin', false],
    ['linux', true],
  ] as const) {
    const platform = createLocalPlatform(platformName);
    const registry = new AdapterRegistry({
      credentials: { async resolve() {} },
      logger: { event() {} },
    });
    registry.register(
      localAdapterFactory(
        () => [temporary.path],
        async () => [],
        platform,
      ),
    );
    await registry.connect({ id: 'local', provider: 'local', configuration: {} });
    try {
      const storage = new StorageAccess(registry);
      const spaces = await storage.listSpaces('local');
      expect(spaces).toHaveLength(1);
      expect(spaces[0]?.semantics).toEqual({
        allowsDuplicateNames: false,
        caseSensitive: expectedCaseSensitive,
      });
    } finally {
      await registry.dispose();
    }
  }
});

it('maps cross-platform filesystem errors to normalized storage errors', () => {
  const cases = [
    ['EROFS', 'PermissionDenied'],
    ['ENOSPC', 'InsufficientSpace'],
    ['EDQUOT', 'InsufficientSpace'],
    ['EISDIR', 'InvalidArgument'],
    ['EXDEV', 'Unsupported'],
  ] as const;

  for (const [errno, expected] of cases) {
    let thrown: unknown;
    try {
      localFailure(Object.assign(new Error(errno), { code: errno }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: expected, providerCode: errno });
  }
});

it('moves local files and folders across directories and rejects conflicts and self-containment', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-move-'));
  await mkdir(join(temporary.path, 'src'));
  await mkdir(join(temporary.path, 'dst'));
  await mkdir(join(temporary.path, 'src', 'sub'));
  await writeFile(join(temporary.path, 'src', 'report.txt'), 'moved content');
  await writeFile(join(temporary.path, 'src', 'sub', 'child.txt'), 'nested');
  await writeFile(join(temporary.path, 'dst', 'existing.txt'), 'already there');
  const { registry, storage, root } = await setup(temporary.path);
  try {
    const fileRef = { ...root, locator: 'src/report.txt' };
    const dstRef = { ...root, locator: 'dst' };
    expect((await storage.stat(fileRef)).capabilities.moveWithin?.support).toBe('supported');

    const movedFile = await storage.moveWithin(fileRef, { parent: dstRef, name: 'report.txt' });
    expect(movedFile).toMatchObject({
      name: 'report.txt',
      ref: { ...root, locator: 'dst/report.txt' },
    });
    expect(await readFile(join(temporary.path, 'dst', 'report.txt'), 'utf8')).toBe('moved content');
    await expect(storage.stat(fileRef)).rejects.toMatchObject({ code: 'NotFound' });

    await expect(
      storage.moveWithin(movedFile.ref, { parent: dstRef, name: 'existing.txt' }),
    ).rejects.toMatchObject({ code: 'AlreadyExists' });

    const srcRef = { ...root, locator: 'src' };
    const subRef = { ...root, locator: 'src/sub' };
    await expect(storage.moveWithin(srcRef, { parent: srcRef, name: 'src' })).rejects.toMatchObject(
      { code: 'InvalidArgument' },
    );
    await expect(storage.moveWithin(srcRef, { parent: subRef, name: 'src' })).rejects.toMatchObject(
      { code: 'InvalidArgument' },
    );

    const movedFolder = await storage.moveWithin(subRef, { parent: dstRef, name: 'sub' });
    expect(movedFolder).toMatchObject({
      kind: 'directory',
      name: 'sub',
      ref: { ...root, locator: 'dst/sub' },
    });
    expect(await readFile(join(temporary.path, 'dst', 'sub', 'child.txt'), 'utf8')).toBe('nested');
    await expect(storage.stat(subRef)).rejects.toMatchObject({ code: 'NotFound' });
  } finally {
    await registry.dispose();
  }
});
