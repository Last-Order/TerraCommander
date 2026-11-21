import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Entry, EntryPage, EntryRef } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import { AdapterRegistry, StorageAccess, StorageError, type WriteExecution } from '@main/storage';
import { localAdapterFactory, localSpace } from '@main/storage/providers/local/local-adapter';
import type { DownloadService } from '../downloads/download-service';
import type { StorageBrowser } from '../storage/storage-browser';
import { UploadService } from '../uploads/upload-service';
import { allocateCopyName, isSubpath } from './copy-paste';
import { StorageTaskService } from './storage-task-service';

const cloudConnectionA = '5e45885a-89f0-462e-9821-7195cba174e5';
const cloudConnectionB = '7c3a1120-2a4c-4c5c-9c8b-1d2e3f4a5b6c';

function createMockBrowser() {
  const statEntry = vi.fn<StorageBrowser['statEntry']>();
  const resolveLocalPath = vi.fn<StorageBrowser['resolveLocalPath']>();
  const listDirectory = vi.fn<StorageBrowser['listDirectory']>();
  const createDirectory = vi.fn<StorageBrowser['createDirectory']>();
  const copyWithin = vi.fn<StorageBrowser['copyWithin']>();
  const downloads = {
    prepare: vi.fn(async () => ({
      ref: { planId: 'single-plan', itemId: 0 },
      path: 'D:\\LocalTarget\\report.txt',
    })),
    prepareBatch: vi.fn(),
    confirmBatch: vi.fn(),
    discoverBatchDirectory: vi.fn<DownloadService['discoverBatchDirectory']>(async () => ({
      items: [],
    })),
    resolveWork: vi.fn(async () => ({ id: 'exec-1', path: 'D:\\LocalTarget\\report.txt' })),
    cancelWork: vi.fn(async () => undefined),
    releaseWork: vi.fn(async () => undefined),
    cancelBatchItem: vi.fn(async () => undefined),
    finishBatch: vi.fn(),
    releaseBatch: vi.fn(async () => undefined),
    run: vi.fn<DownloadService['run']>(async () => ({ status: 'completed' })),
    pause: vi.fn(async () => undefined),
    runWork: vi.fn<DownloadService['runWork']>(async () => ({ status: 'completed' })),
    pauseWork: vi.fn<DownloadService['pauseWork']>(async () => undefined),
  };
  const uploads = new UploadService({
    stat: statEntry,
    createDirectory: async (target) => createDirectory(target),
    prepareUpload: (_parent, name) =>
      ({
        run: async () => ({
          ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: `uploaded-${name}` },
          name,
          kind: 'file',
          capabilities: {},
        }),
      }) satisfies WriteExecution,
  });

  const browser = {
    statEntry,
    resolveLocalPath,
    listDirectory,
    createDirectory,
    copyWithin,
    downloads: downloads as unknown as DownloadService,
    uploads,
  } as unknown as StorageBrowser;

  return {
    browser,
    statEntry,
    resolveLocalPath,
    listDirectory,
    createDirectory,
    copyWithin,
    downloads,
  };
}

it('allocates non-conflicting copy names for files and directories', () => {
  const used = new Set(['report.pdf', 'report - Copy.pdf', 'docs']);
  expect(allocateCopyName('report.pdf', 'file', used)).toBe('report - Copy (2).pdf');
  expect(allocateCopyName('notes', 'file', used)).toBe('notes - Copy');
  expect(allocateCopyName('docs', 'directory', used)).toBe('docs - Copy');
  expect(allocateCopyName('docs', 'directory', used)).toBe('docs - Copy (2)');

  const usedCaseInsensitive = new Set(['report.pdf', 'report - copy.pdf']);
  expect(allocateCopyName('report.pdf', 'file', usedCaseInsensitive, true)).toBe(
    'report - Copy (2).pdf',
  );
});

it('detects subpath containment without false positives on sibling prefixes', () => {
  const parent = join('D:', 'Work', 'docs');
  expect(isSubpath(parent, join(parent, 'sub'))).toBe(true);
  expect(isSubpath(parent, parent)).toBe(false);
  expect(isSubpath(parent, join('D:', 'Work', 'docs-2'))).toBe(false);
});

it('rejects cross-source cloud-to-cloud paste with Unsupported', async () => {
  const { browser } = createMockBrowser();
  const service = new StorageTaskService(browser);
  const sourceParent: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'a' };
  const targetParent: EntryRef = { connectionId: cloudConnectionB, spaceId: 'drive', locator: 'b' };

  await expect(
    service.pasteEntries(1, {
      sourceParent,
      sourceDirectoryPath: 'Drive A',
      entries: [
        {
          ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-1' },
          name: 'report.txt',
          kind: 'file',
          capabilities: {},
        },
      ],
      targetParent,
      targetDirectoryPath: 'Drive B',
    }),
  ).rejects.toMatchObject({ code: 'Unsupported' } satisfies Partial<StorageError>);

  await service.dispose();
});

it('maps cloud-to-local paste to a download task targeting the local directory', async () => {
  const { browser, resolveLocalPath, downloads } = createMockBrowser();
  const service = new StorageTaskService(browser);
  const sourceParent: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'a' };
  const targetParent: EntryRef = {
    connectionId: localConnectionId,
    spaceId: 'local-1',
    locator: '.',
  };
  resolveLocalPath.mockResolvedValueOnce({
    path: 'D:\\LocalTarget',
    kind: 'directory',
  });

  const response = await service.pasteEntries(1, {
    sourceParent,
    sourceDirectoryPath: 'My Drive',
    entries: [
      {
        ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-1' },
        name: 'report.txt',
        kind: 'file',
        capabilities: { read: { support: 'supported' } },
      },
    ],
    targetParent,
    targetDirectoryPath: 'LocalTarget',
  });

  expect(response).toEqual({ status: 'started' });
  expect(downloads.prepare).toHaveBeenCalledWith(
    0,
    expect.objectContaining({
      directory: 'D:\\LocalTarget',
      ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-1' },
      expectedName: 'report.txt',
    }),
  );
  expect(service.getSnapshot().tasks[0]?.request.type).toBe('download');

  await service.dispose();
});

it('maps same-connection single file copy to a copy task and auto-renames in same directory', async () => {
  const { browser, listDirectory, copyWithin } = createMockBrowser();
  const service = new StorageTaskService(browser);
  const parent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'folder-1',
  };
  const file: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-1' },
    name: 'report.txt',
    kind: 'file',
    capabilities: { copyWithin: { support: 'supported' } },
  };
  listDirectory.mockResolvedValueOnce({ entries: [file] } satisfies EntryPage);
  copyWithin.mockResolvedValueOnce({
    ...file,
    ref: { ...file.ref, locator: 'file-2' },
    name: 'report - Copy.txt',
  });

  const response = await service.pasteEntries(1, {
    sourceParent: parent,
    sourceDirectoryPath: 'My Drive / Folder',
    entries: [file],
    targetParent: parent,
    targetDirectoryPath: 'My Drive / Folder',
  });

  expect(response).toEqual({ status: 'started' });
  await vi.waitFor(() => {
    expect(copyWithin).toHaveBeenCalledWith(file.ref, {
      parent,
      name: 'report - Copy.txt',
    });
  });
  expect(service.getSnapshot().tasks[0]?.request.type).toBe('copy');
  expect(service.getSnapshot().groups).toHaveLength(0);

  await service.dispose();
});

it('maps same-connection folder copy to a copy task group and copies children recursively', async () => {
  const { browser, listDirectory, createDirectory, copyWithin } = createMockBrowser();
  const service = new StorageTaskService(browser);
  const sourceParent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'src',
  };
  const targetParent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'dst',
  };
  const folder: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'dir-1' },
    name: 'docs',
    kind: 'directory',
    capabilities: { list: { support: 'supported' } },
  };
  const childFile: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-2' },
    name: 'readme.md',
    kind: 'file',
    capabilities: { copyWithin: { support: 'supported' } },
  };
  const createdFolderRef: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'dir-copy-1',
  };
  createDirectory.mockResolvedValueOnce({
    ref: createdFolderRef,
    name: 'docs',
    kind: 'directory',
    capabilities: {},
  });
  listDirectory.mockResolvedValueOnce({ entries: [childFile] });
  copyWithin.mockResolvedValueOnce({
    ...childFile,
    ref: { ...childFile.ref, locator: 'file-copy-2' },
  });

  await service.pasteEntries(1, {
    sourceParent,
    sourceDirectoryPath: 'Source',
    entries: [folder],
    targetParent,
    targetDirectoryPath: 'Target',
  });

  await vi.waitFor(() => {
    expect(copyWithin).toHaveBeenCalledWith(childFile.ref, {
      parent: createdFolderRef,
      name: 'readme.md',
    });
  });
  const snapshot = service.getSnapshot();
  expect(snapshot.groups).toHaveLength(1);
  expect(snapshot.groups[0]?.request.kind).toBe('copy');
  expect(snapshot.tasks).toHaveLength(1);
  expect(snapshot.tasks[0]?.groupId).toBe(snapshot.groups[0]?.id);

  await service.dispose();
});

it('copies local files and creates directories through StorageAccess capability checks', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-local-copy-'));
  await writeFile(join(temporary.path, 'notes.txt'), 'hello copy');
  const registry = new AdapterRegistry({
    credentials: { async resolve() {} },
    logger: { event() {} },
  });
  registry.register(
    localAdapterFactory(
      () => [temporary.path],
      async () => [],
    ),
  );
  await registry.connect({ id: localConnectionId, provider: 'local', configuration: {} });
  const storage = new StorageAccess(registry);
  const root = localSpace(localConnectionId, temporary.path).root;
  try {
    const copied = await storage.copyWithin(
      { ...root, locator: 'notes.txt' },
      { parent: root, name: 'notes - Copy.txt' },
    );
    expect(copied.name).toBe('notes - Copy.txt');
    expect(await readFile(join(temporary.path, 'notes - Copy.txt'), 'utf8')).toBe('hello copy');

    const createdDir = await storage.createDirectory({ parent: root, name: 'sub' });
    expect(createdDir.kind).toBe('directory');
    expect(createdDir.name).toBe('sub');
  } finally {
    await registry.dispose();
  }
});

it('rejects entries whose connectionId or spaceId does not match sourceParent', async () => {
  const { browser } = createMockBrowser();
  const service = new StorageTaskService(browser);
  const sourceParent: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'a' };
  const targetParent: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'b' };

  await expect(
    service.pasteEntries(1, {
      sourceParent,
      sourceDirectoryPath: 'Drive A',
      entries: [
        {
          ref: { connectionId: localConnectionId, spaceId: 'local-1', locator: 'secret.txt' },
          name: 'secret.txt',
          kind: 'file',
          capabilities: {},
        },
      ],
      targetParent,
      targetDirectoryPath: 'Drive A / Sub',
    }),
  ).rejects.toMatchObject({ code: 'InvalidArgument' } satisfies Partial<StorageError>);

  await service.dispose();
});

it('reports a preparation issue instead of enqueueing a copy task for symlinks inside folders', async () => {
  const { browser, listDirectory, createDirectory, copyWithin } = createMockBrowser();
  const service = new StorageTaskService(browser);
  const sourceParent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'src',
  };
  const targetParent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'dst',
  };
  const folder: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'dir-1' },
    name: 'docs',
    kind: 'directory',
    capabilities: { list: { support: 'supported' } },
  };
  const symlinkEntry: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'link-1' },
    name: 'shortcut',
    kind: 'link',
    capabilities: {},
  };
  createDirectory.mockResolvedValueOnce({
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'dir-copy-1' },
    name: 'docs',
    kind: 'directory',
    capabilities: {},
  });
  listDirectory.mockResolvedValueOnce({ entries: [symlinkEntry] });

  await service.pasteEntries(1, {
    sourceParent,
    sourceDirectoryPath: 'Source',
    entries: [folder],
    targetParent,
    targetDirectoryPath: 'Target',
  });

  await vi.waitFor(() => {
    expect(service.getSnapshot().groups[0]?.preparation.status).toBe('completed');
  });
  expect(copyWithin).not.toHaveBeenCalled();
  expect(service.getSnapshot().tasks).toHaveLength(0);
  expect(service.getSnapshot().groups[0]?.preparation.issues).toHaveLength(1);
  expect(service.getSnapshot().groups[0]?.preparation.issues[0]?.failure.code).toBe('Unsupported');

  await service.dispose();
});
