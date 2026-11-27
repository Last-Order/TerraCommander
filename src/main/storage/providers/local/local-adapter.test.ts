import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import {
  AdapterRegistry,
  StorageAccess,
  type ReopenableByteSource,
  type StreamingByteSource,
} from '../..';
import {
  inspectLocalTransfer,
  localAdapterFactory,
  localFailure,
  localSpace,
} from './local-adapter';
import { createLocalPlatform } from './local-platform';

async function setup(path: string) {
  const registry = new AdapterRegistry({
    credentials: { async resolve() {} },
    logger: { event() {} },
  });
  registry.register(localAdapterFactory(async () => [path]));
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
      read: { support: 'supported' },
      rangeRead: { support: 'supported' },
      conditionalRead: { support: 'supported' },
      write: { support: 'unknown' },
      streamingWrite: { support: 'supported' },
      pausableWrite: { support: 'supported' },
      replaceWrite: { support: 'supported' },
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
    registry.register(localAdapterFactory(async () => [temporary.path], platform));
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

it('evaluates subpath and self-containment rules per local platform', async () => {
  const win = createLocalPlatform('win32');
  const mac = createLocalPlatform('darwin');
  const linux = createLocalPlatform('linux');

  expect(win.isSubpath('D:\\Work\\docs', 'D:\\Work\\docs\\sub')).toBe(true);
  expect(win.isSubpath('D:\\Work\\docs', 'd:\\work\\DOCS\\sub')).toBe(true);
  expect(win.isSubpath('D:\\Work\\docs', 'D:\\Work\\docs')).toBe(false);
  expect(win.isSameOrSubpath('D:\\Work\\docs', 'd:\\work\\DOCS')).toBe(true);
  expect(win.isSubpath('D:\\Work\\docs', 'D:\\Work\\docs-2')).toBe(false);
  expect(win.isSubpath('C:\\Work\\docs', 'D:\\Work\\docs\\sub')).toBe(false);

  expect(mac.isSubpath('/Users/docs', '/users/DOCS/sub')).toBe(true);
  expect(mac.isSameOrSubpath('/Users/docs', '/users/DOCS')).toBe(true);
  expect(mac.isSubpath('/Users/docs', '/Users/docs-2')).toBe(false);

  expect(linux.isSubpath('/home/docs', '/home/docs/sub')).toBe(true);
  expect(linux.isSubpath('/home/docs', '/home/DOCS/sub')).toBe(false);
  expect(linux.isSubpath('/home/docs', '/home/docs/..hidden')).toBe(true);

  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-inspect-transfer-'));
  await mkdir(join(temporary.path, 'src'));
  await mkdir(join(temporary.path, 'src', 'nested'));
  await mkdir(join(temporary.path, 'dst'));
  await writeFile(join(temporary.path, 'src', 'file.txt'), 'data');
  const root = localSpace('local', temporary.path).root;
  const volumes = async () => [temporary.path];

  expect(
    await inspectLocalTransfer(
      { ...root, locator: 'src/nested' },
      [{ ref: { ...root, locator: 'src' }, kind: 'directory' }],
      'copy',
      volumes,
    ),
  ).toEqual({ selfContained: true, moveStrategy: 'native' });

  expect(
    await inspectLocalTransfer(
      { ...root, locator: 'src' },
      [{ ref: { ...root, locator: 'src' }, kind: 'directory' }],
      'move',
      volumes,
    ),
  ).toEqual({ selfContained: true, moveStrategy: 'native' });

  expect(
    await inspectLocalTransfer(
      { ...root, locator: 'dst' },
      [{ ref: { ...root, locator: 'src/file.txt' }, kind: 'file' }],
      'move',
      volumes,
    ),
  ).toEqual({ selfContained: false, moveStrategy: 'native' });

  await expect(
    inspectLocalTransfer(
      { ...root, locator: 'src/file.txt' },
      [{ ref: { ...root, locator: 'src' }, kind: 'directory' }],
      'copy',
      volumes,
    ),
  ).rejects.toMatchObject({ code: 'InvalidArgument' });
});

it('reads local files with ranges, expectedRevision, and detects concurrent changes', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-local-read-'));
  const filePath = join(temporary.path, 'data.txt');
  await writeFile(filePath, '0123456789');
  const { registry, storage, root } = await setup(temporary.path);
  try {
    const fileRef = { ...root, locator: 'data.txt' };
    const stat = await storage.stat(fileRef);
    expect(stat.revision).toBeTruthy();
    expect(stat.capabilities.read?.support).toBe('supported');
    expect(stat.capabilities.rangeRead?.support).toBe('supported');
    expect(stat.capabilities.conditionalRead?.support).toBe('supported');

    const full = await storage.read(fileRef, { expectedRevision: stat.revision });
    const fullChunks: Uint8Array[] = [];
    for await (const chunk of full.stream) fullChunks.push(chunk as Uint8Array);
    expect(Buffer.concat(fullChunks).toString()).toBe('0123456789');
    await full.dispose();

    const ranged = await storage.read(fileRef, { range: { offset: 3, length: 4 } });
    const rangedChunks: Uint8Array[] = [];
    for await (const chunk of ranged.stream) rangedChunks.push(chunk as Uint8Array);
    expect(Buffer.concat(rangedChunks).toString()).toBe('3456');
    await ranged.dispose();

    await expect(
      storage.read(fileRef, { expectedRevision: 'stale-revision' }),
    ).rejects.toMatchObject({ code: 'PreconditionFailed' });
  } finally {
    await registry.dispose();
  }
});

it('writes local files via create, replace, one-shot, and resumable pause/resume with checksum verification', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-local-write-'));
  await writeFile(join(temporary.path, 'existing.txt'), 'original');
  const { registry, storage, root } = await setup(temporary.path);
  try {
    // One-shot streaming write
    const oneShot: StreamingByteSource = {
      kind: 'one-shot',
      open: async () => ({
        stream: Readable.from([Buffer.from('streamed')], { objectMode: false }),
        dispose: async () => {},
      }),
    };
    const created = await storage.write(
      { kind: 'create', parent: root, name: 'one-shot.txt', policy: 'create-only' },
      oneShot,
    );
    expect(created.name).toBe('one-shot.txt');
    expect(await readFile(join(temporary.path, 'one-shot.txt'), 'utf8')).toBe('streamed');

    // Exclusive create fails if already exists
    await expect(
      storage.write(
        { kind: 'create', parent: root, name: 'existing.txt', policy: 'create-only' },
        {
          kind: 'one-shot',
          open: async () => ({
            stream: Readable.from([Buffer.from('dup')], { objectMode: false }),
            dispose: async () => {},
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'AlreadyExists' });

    // Resumable replace with pause, resume, and full checksum verification before publish
    const content = Buffer.from('0123456789abcdef');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const pause = new AbortController();
    let openCount = 0;
    const source: ReopenableByteSource = {
      kind: 'reopenable',
      size: content.length,
      descriptor: {
        identity: 'remote-1',
        revision: sha256,
        size: content.length,
        verification: 'strong',
        checksum: { algorithm: 'sha256', value: sha256 },
      },
      verify: async () => true,
      async open(range) {
        openCount += 1;
        if (openCount === 1) {
          const stream = new Readable({
            read() {},
          });
          stream.push(content.subarray(0, 6));
          setTimeout(() => pause.abort(), 10);
          return { stream, length: content.length, dispose: async () => {} };
        }
        expect(range).toEqual({ offset: 6 });
        const tail = content.subarray(6);
        return {
          stream: Readable.from([tail], { objectMode: false }),
          length: tail.length,
          dispose: async () => {},
        };
      },
    };
    const replaceRef = { ...root, locator: 'existing.txt' };
    const session = storage.createWriteSession(
      { kind: 'replace', ref: replaceRef, policy: 'replace-unconditionally' },
      source,
    );
    await expect(session.run({ pauseSignal: pause.signal })).rejects.toMatchObject({
      code: 'Cancelled',
    });
    // Original file remains untouched while replacement is paused.
    expect(await readFile(join(temporary.path, 'existing.txt'), 'utf8')).toBe('original');

    const replaced = await session.run({});
    expect(replaced.size).toBe(content.length);
    expect(await readFile(join(temporary.path, 'existing.txt'))).toEqual(content);

    // Paused create-only discard cleans up partial file safely.
    const pause2 = new AbortController();
    const discardSource: ReopenableByteSource = {
      kind: 'reopenable',
      size: 16,
      descriptor: { identity: 'd', revision: 'r', size: 16, verification: 'weak' },
      verify: async () => true,
      async open() {
        const stream = new Readable({ read() {} });
        stream.push(Buffer.from('1234'));
        setTimeout(() => pause2.abort(), 10);
        return { stream, length: 16, dispose: async () => {} };
      },
    };
    const discardExec = storage.createWriteSession(
      { kind: 'create', parent: root, name: 'partial.bin', policy: 'create-only' },
      discardSource,
    );
    await expect(discardExec.run({ pauseSignal: pause2.signal })).rejects.toMatchObject({
      code: 'Cancelled',
    });
    expect(await readdir(temporary.path)).toContain('partial.bin');
    await discardExec.discard?.();
    expect(await readdir(temporary.path)).not.toContain('partial.bin');
  } finally {
    await registry.dispose();
  }
});

it('protects local directory identities across batch scopes and removes only empty created dirs', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-local-scope-'));
  const { registry, storage, root } = await setup(temporary.path);
  try {
    const scope = await storage.openDirectoryScope(root);
    const { entry: dirA, created } = await scope.ensureDirectory(root, 'A', { replace: false });
    expect(created).toBe(true);

    // Replace A with a different directory at the same path.
    await rename(join(temporary.path, 'A'), join(temporary.path, 'A-moved'));
    await mkdir(join(temporary.path, 'A'));
    await writeFile(join(temporary.path, 'A', 'external.txt'), 'external');

    const openSpy = vi.fn();
    await expect(
      storage.write(
        { kind: 'create', parent: dirA.ref, name: 'file.txt', policy: 'create-only' },
        { kind: 'one-shot', open: openSpy },
        {},
        { directoryScope: scope },
      ),
    ).rejects.toMatchObject({ code: 'PreconditionFailed' });
    // Directory identity failure happens BEFORE opening source stream.
    expect(openSpy).not.toHaveBeenCalled();

    // Cleanup must not delete the externally created A directory.
    await scope.cleanupCreated();
    expect(await readFile(join(temporary.path, 'A', 'external.txt'), 'utf8')).toBe('external');

    // Fresh scope cleans up empty created dir, but skips non-empty dir without recursive delete.
    const scope2 = await storage.openDirectoryScope(root);
    const { entry: dirB } = await scope2.ensureDirectory(root, 'B', { replace: false });
    await scope2.ensureDirectory(dirB.ref, 'empty-child', { replace: false });
    await writeFile(join(temporary.path, 'B', 'keep.txt'), 'keep');
    await scope2.cleanupCreated();
    expect(await readdir(join(temporary.path, 'B'))).toEqual(['keep.txt']);
  } finally {
    await registry.dispose();
  }
});

it('supports safe local removal with onlyIfEmpty and expectedRevision checks', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-local-safe-rm-'));
  await mkdir(join(temporary.path, 'dir'));
  await writeFile(join(temporary.path, 'dir', 'child.txt'), 'v1');
  const { registry, storage, root } = await setup(temporary.path);
  try {
    const dirRef = { ...root, locator: 'dir' };
    const fileRef = { ...root, locator: 'dir/child.txt' };
    const stat = await storage.stat(fileRef);

    // Non-empty directory must not be deleted when onlyIfEmpty is true.
    await expect(storage.remove(dirRef, {}, { onlyIfEmpty: true })).rejects.toMatchObject({
      code: 'PreconditionFailed',
    });
    expect(await readFile(join(temporary.path, 'dir', 'child.txt'), 'utf8')).toBe('v1');

    // Stale revision rejects file deletion as SourceChanged.
    await expect(storage.remove(fileRef, {}, { expectedRevision: 'stale' })).rejects.toMatchObject({
      code: 'SourceChanged',
    });

    // Matching revision deletes file, then empty dir can be deleted with onlyIfEmpty.
    await storage.remove(fileRef, {}, { expectedRevision: stat.revision, expectedSize: 2 });
    await storage.remove(dirRef, {}, { onlyIfEmpty: true });
    expect(await readdir(temporary.path)).toEqual([]);
  } finally {
    await registry.dispose();
  }
});
