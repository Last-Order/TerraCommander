import { mkdir, mkdtempDisposable, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AdapterRegistry, StorageAccess } from '../..';
import { localAdapterFactory, localSpace } from './local-adapter';

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
    storage: new StorageAccess(registry, { async load() {}, async save() {} }),
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
    expect((await storage.list(folder.ref)).entries).toMatchObject([{ name: 'child.txt' }]);
    if (process.platform === 'win32') {
      await storage.rename(renamed.ref, '重命名.TXT');
      expect(await readdir(temporary.path)).toContain('重命名.TXT');
    }
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
      storage.rename({ ...root, locator: join('redirect', 'secret.txt') }, 'changed.txt'),
    ).rejects.toMatchObject({ code: 'NotFound' });
    expect(await readFile(join(saved, 'source.txt'), 'utf8')).toBe('source');
    expect(await readFile(join(saved, 'existing.txt'), 'utf8')).toBe('existing');
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
  } finally {
    await registry.dispose();
  }
});
