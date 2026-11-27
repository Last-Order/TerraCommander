import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { WriteExecution } from '@main/storage/core/contracts';
import { StorageError } from '@main/storage/core/errors';
import type { Entry, EntryRef, SpaceSemantics } from '@shared/storage';
import type { StorageDirectory } from '../storage/storage-directory';
import { allocateUploadNames, commonLocalParent } from './upload-names';
import { UploadService } from './upload-service';
import type { UploadOperations } from './upload-types';

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

function createUploadOperations(semantics?: SpaceSemantics) {
  let nextId = 1;
  const createdDirs: { parent: EntryRef; name: string; entry: Entry }[] = [];
  const preparedUploads: { parent: EntryRef; name: string; size: number }[] = [];
  const stat = vi.fn(async (ref: EntryRef) => directoryEntry(ref, ref.locator, 'Root'));
  const unsupported = () => Promise.reject(new StorageError('Unsupported'));

  const directory: UploadOperations['directory'] = (ref) => {
    const handle: StorageDirectory = {
      ref,
      child: (childRef) => directory(childRef),
      file: (fileRef) => ({ ref: fileRef, stat: unsupported, read: unsupported }),
      stat: () => stat(ref),
      semantics: async () => semantics,
      capabilities: unsupported,
      list: unsupported,
      openScope: unsupported,
      createDirectory: vi.fn(async (name: string) => {
        const entry = directoryEntry(ref, `dir-${nextId++}`, name);
        createdDirs.push({ parent: ref, name, entry });
        return { entry, directory: directory(entry.ref) };
      }),
      write: unsupported,
      prepareWrite: () => ({ run: unsupported }),
      prepareUpload: vi.fn((name, source): WriteExecution => {
        preparedUploads.push({ parent: ref, name, size: source.descriptor.size });
        return {
          run: async () => ({
            ref: { ...ref, locator: `file-${nextId++}` },
            name,
            kind: 'file',
            size: source.descriptor.size,
            capabilities: {},
          }),
        };
      }),
      copyEntry: unsupported,
      moveEntry: unsupported,
    };
    return handle;
  };

  return { operations: { directory }, stat, createdDirs, preparedUploads };
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

it('allocates sibling names according to destination SpaceSemantics', () => {
  const mixedCase = [
    { name: 'A.txt', kind: 'file' as const },
    { name: 'a.txt', kind: 'file' as const },
  ];

  // Default (unknown semantics) and explicit case-sensitive targets keep A.txt and a.txt distinct.
  expect(allocateUploadNames(mixedCase)).toEqual(['A.txt', 'a.txt']);
  expect(allocateUploadNames(mixedCase, { caseSensitive: true })).toEqual(['A.txt', 'a.txt']);

  // Case-insensitive targets disambiguate A.txt and a.txt without relying on host OS path rules.
  expect(allocateUploadNames(mixedCase, { caseSensitive: false })).toEqual([
    'A (1).txt',
    'a (2).txt',
  ]);
  expect(
    allocateUploadNames([...mixedCase, { name: 'A (1).txt', kind: 'file' }], {
      caseSensitive: false,
    }),
  ).toEqual(['A (2).txt', 'a (3).txt', 'A (1).txt']);

  // Duplicate-allowing targets (such as Google Drive) preserve all original names.
  expect(
    allocateUploadNames(
      [...mixedCase, { name: 'notes.txt', kind: 'file' }, { name: 'notes.txt', kind: 'file' }],
      { allowsDuplicateNames: true, caseSensitive: true },
    ),
  ).toEqual(['A.txt', 'a.txt', 'notes.txt', 'notes.txt']);
  expect(
    allocateUploadNames(
      [...mixedCase, { name: 'notes.txt', kind: 'file' }, { name: 'notes.txt', kind: 'file' }],
      { allowsDuplicateNames: true, caseSensitive: false },
    ),
  ).toEqual(['A.txt', 'a.txt', 'notes.txt', 'notes.txt']);
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

  const { operations, createdDirs, preparedUploads } = createUploadOperations();
  const service = new UploadService(operations);
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

it('uses destination directory semantics when naming batch upload roots', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-semantics-'));
  const dirA = join(temporary.path, 'one');
  const dirB = join(temporary.path, 'two');
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  const upper = join(dirA, 'A.txt');
  const lower = join(dirB, 'a.txt');
  await writeFile(upper, 'upper');
  await writeFile(lower, 'lower');

  const caseSensitiveService = new UploadService(
    createUploadOperations({ allowsDuplicateNames: false, caseSensitive: true }).operations,
  );
  const caseInsensitiveService = new UploadService(
    createUploadOperations({ allowsDuplicateNames: false, caseSensitive: false }).operations,
  );
  const duplicateAllowedService = new UploadService(
    createUploadOperations({ allowsDuplicateNames: true, caseSensitive: true }).operations,
  );

  try {
    const sensitiveBatch = await caseSensitiveService.prepareBatch(1, {
      parent: rootParent,
      paths: [upper, lower],
    });
    expect(sensitiveBatch.items.map((item) => item.name)).toEqual(['A.txt', 'a.txt']);

    const insensitiveBatch = await caseInsensitiveService.prepareBatch(1, {
      parent: rootParent,
      paths: [upper, lower],
    });
    expect(insensitiveBatch.items.map((item) => item.name)).toEqual(['A (1).txt', 'a (2).txt']);

    const duplicateBatch = await duplicateAllowedService.prepareBatch(1, {
      parent: rootParent,
      paths: [upper, lower],
    });
    expect(duplicateBatch.items.map((item) => item.name)).toEqual(['A.txt', 'a.txt']);
  } finally {
    await Promise.all([
      caseSensitiveService.dispose(),
      caseInsensitiveService.dispose(),
      duplicateAllowedService.dispose(),
    ]);
  }
});

it('defers remote destination validation when deferValidation is enabled', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-upload-defer-'));
  const singleFile = join(temporary.path, 'single.txt');
  const folder = join(temporary.path, 'folder');
  await writeFile(singleFile, 'abc');
  await mkdir(folder, { recursive: true });

  const { operations, stat } = createUploadOperations();
  const service = new UploadService(operations);

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
