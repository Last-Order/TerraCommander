import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Entry, EntryRef } from '@shared/storage';
import type { WriteExecution } from '@main/storage/core/contracts';
import { allocateUploadNames, commonLocalParent } from './upload-names';
import { UploadService } from './upload-service';
import type { UploadDestination } from './upload-types';

const connectionId = '5e45885a-89f0-462e-9821-7195cba174e5';
const rootParent: EntryRef = { connectionId, spaceId: 'my-drive', locator: 'root' };

function directoryEntry(parent: EntryRef, locator: string, name: string): Entry {
  return {
    ref: { ...parent, locator },
    name,
    kind: 'directory',
    capabilities: {
      write: { support: 'supported' },
      createDirectory: { support: 'supported' },
    },
  };
}

function createDestination() {
  let nextId = 1;
  const createdDirs: { parent: EntryRef; name: string; entry: Entry }[] = [];
  const preparedUploads: { parent: EntryRef; name: string; size: number }[] = [];
  const stat = vi.fn(async (ref: EntryRef) => directoryEntry(ref, ref.locator, 'Root'));
  const destination: UploadDestination = {
    stat,
    createDirectory: vi.fn(async ({ parent, name }) => {
      const entry = directoryEntry(parent, `dir-${nextId++}`, name);
      createdDirs.push({ parent, name, entry });
      return entry;
    }),
    prepareUpload: vi.fn((parent, name, source): WriteExecution => {
      preparedUploads.push({ parent, name, size: source.descriptor.size });
      return {
        run: async () => ({
          ref: { ...parent, locator: `file-${nextId++}` },
          name,
          kind: 'file',
          size: source.descriptor.size,
          capabilities: {},
        }),
      };
    }),
  };
  return { destination, stat, createdDirs, preparedUploads };
}

it('allocates unique sibling names and computes common local parent', () => {
  expect(
    allocateUploadNames([
      { name: 'notes.txt', kind: 'file' },
      { name: 'notes.txt', kind: 'file' },
      { name: 'docs', kind: 'directory' },
      { name: 'docs', kind: 'directory' },
    ]),
  ).toEqual(['notes (1).txt', 'notes (2).txt', 'docs (1)', 'docs (2)']);

  expect(commonLocalParent(['C:\\work\\a\\one.txt', 'C:\\work\\b\\two.txt'])).toBe('C:\\work');
});

it('discovers mixed files and folders across pages and resolves nested upload destinations', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-plan-'));
  const rootFile = join(temporary.path, 'readme.txt');
  const folder = join(temporary.path, 'album');
  const nested = join(folder, 'nested');
  const emptyFolder = join(folder, 'empty');
  await writeFile(rootFile, 'hello');
  await mkdir(nested, { recursive: true });
  await mkdir(emptyFolder, { recursive: true });
  await writeFile(join(nested, 'photo.jpg'), 'jpeg-bytes');
  for (let index = 0; index < 35; index++) {
    await writeFile(join(folder, `item-${String(index).padStart(2, '0')}.txt`), `${index}`);
  }

  const { destination, createdDirs, preparedUploads } = createDestination();
  const service = new UploadService(destination);
  const directoryEvents: { parent: EntryRef; entry: Entry }[] = [];

  try {
    const batch = await service.prepareBatch(1, {
      parent: rootParent,
      paths: [rootFile, folder],
      onDirectoryCreated: (parent, entry) => directoryEvents.push({ parent, entry }),
    });
    expect(batch.sourcePath).toBe(temporary.path);
    expect(batch.items.map((item) => [item.kind, item.name])).toEqual([
      ['file', 'readme.txt'],
      ['directory', 'album'],
    ]);

    const albumItem = batch.items[1]!;
    const page1 = await service.discoverBatchDirectory(1, batch.id, albumItem.id, 0);
    expect(page1.items).toHaveLength(32);
    expect(page1.nextOffset).toBe(32);

    const page2 = await service.discoverBatchDirectory(
      1,
      batch.id,
      albumItem.id,
      page1.nextOffset!,
    );
    expect(page2.items).toHaveLength(5); // 35 files + empty + nested = 37
    expect(page2.nextOffset).toBeUndefined();

    // Destination folder was created once and retained across pages
    expect(createdDirs).toHaveLength(1);
    expect(createdDirs[0]!.parent).toEqual(rootParent);
    expect(createdDirs[0]!.name).toBe('album');
    expect(directoryEvents).toHaveLength(1);

    const albumRef = createdDirs[0]!.entry.ref;
    const allAlbumItems = [...page1.items, ...page2.items];
    const nestedItem = allAlbumItems.find((item) => item.name === 'nested')!;
    const emptyItem = allAlbumItems.find((item) => item.name === 'empty')!;
    expect(nestedItem.parent).toEqual(albumRef);

    const nestedPage = await service.discoverBatchDirectory(1, batch.id, nestedItem.id, 0);
    expect(nestedPage.items.map((item) => item.path)).toEqual(['album/nested/photo.jpg']);
    const emptyPage = await service.discoverBatchDirectory(1, batch.id, emptyItem.id, 0);
    expect(emptyPage.items).toEqual([]);

    const nestedRef = createdDirs[1]!.entry.ref;
    const photoItem = nestedPage.items[0]!;

    const work = await service.resolveWork(1, { planId: batch.id, itemId: photoItem.id });
    expect(work.parent).toEqual(nestedRef);
    work.prepare();
    expect(preparedUploads).toContainEqual({
      parent: nestedRef,
      name: 'photo.jpg',
      size: 10,
    });
    expect(createdDirs).toHaveLength(3);
  } finally {
    await service.dispose();
  }
});

it('defers remote destination validation when deferValidation is enabled', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-defer-'));
  const singleFile = join(temporary.path, 'single.txt');
  const folder = join(temporary.path, 'folder');
  await writeFile(singleFile, 'abc');
  await mkdir(folder, { recursive: true });

  const { destination, stat } = createDestination();
  const service = new UploadService(destination);

  try {
    const singleSelection = await service.prepareSelection(1, {
      parent: rootParent,
      paths: [singleFile],
      deferValidation: true,
    });
    expect(singleSelection.kind).toBe('single');
    expect(stat).not.toHaveBeenCalled();

    if (singleSelection.kind === 'single') {
      await service.resolveWork(1, singleSelection.work.ref);
      expect(stat).toHaveBeenCalledTimes(1);
    }

    const batchSelection = await service.prepareSelection(1, {
      parent: rootParent,
      paths: [singleFile, folder],
      deferValidation: true,
    });
    expect(batchSelection.kind).toBe('batch');
    expect(stat).toHaveBeenCalledTimes(1);
    if (batchSelection.kind === 'batch') {
      expect(batchSelection.prepared.needsValidation).toEqual({ requireCreateDirectory: true });
    }
  } finally {
    await service.dispose();
  }
});
