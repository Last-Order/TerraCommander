import { mkdir, mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { StorageError } from '@main/storage';
import { localSpace } from '@main/storage/providers/local/local-adapter';
import { entryKey, type Entry, type EntryPage, type EntryRef } from '@shared/storage';
import { internalLocalConnectionId } from '../storage/providers/local-storage-provider';
import { createStorageDirectory } from '../storage/storage-directory';
import type { StorageEntryOperations } from '../storage/storage-entry-operations';
import type { TransferService } from '../transfers/transfer-service';
import type {
  CommittedTransferFile,
  SourceDirectoryCleanupEntry,
} from '../transfers/transfer-types';
import { allocateCopyName } from './copy-paste';
import {
  StorageTaskService,
  type StorageTaskDependencies,
  type StorageTaskOperations,
} from './storage-task-service';

const cloudConnectionA = '5e45885a-89f0-462e-9821-7195cba174e5';
const cloudConnectionB = '7c3a1120-2a4c-4c5c-9c8b-1d2e3f4a5b6c';

function createMockTaskHost() {
  const statEntry = vi.fn<StorageEntryOperations['statEntry']>(async (ref) => ({
    ref,
    name: 'dir',
    kind: 'directory',
    capabilities: {
      write: { support: 'supported' },
      streamingWrite: { support: 'supported' },
      pausableWrite: { support: 'supported' },
      createDirectory: { support: 'supported' },
    },
  }));
  const inspectTransfer = vi.fn<StorageEntryOperations['inspectTransfer']>(
    async (target, sources, mode) => {
      const targetKey = entryKey(target);
      const crossSpace = sources.some((source) => source.ref.spaceId !== target.spaceId);
      return {
        selfContained: sources.some(
          (source) => source.kind === 'directory' && entryKey(source.ref) === targetKey,
        ),
        moveStrategy:
          mode === 'move' && target.connectionId !== internalLocalConnectionId && crossSpace
            ? 'unsupported'
            : 'native',
      };
    },
  );
  const inspectCrossConnectionTransfer = vi.fn<
    StorageEntryOperations['inspectCrossConnectionTransfer']
  >(async () => ({ selfContained: false }));
  const canonicalEntryKey = vi.fn<StorageEntryOperations['canonicalEntryKey']>(async (ref) =>
    entryKey(ref),
  );
  const ancestorLocators = vi.fn<StorageEntryOperations['ancestorLocators']>(async () => undefined);
  const listDirectory = vi.fn<StorageEntryOperations['listDirectory']>(async () => ({
    entries: [],
  }));
  const spaceSemantics = vi.fn<StorageEntryOperations['spaceSemantics']>(async () => undefined);
  const spaceCapabilities = vi.fn<StorageEntryOperations['spaceCapabilities']>(async () => ({
    write: { support: 'supported' },
    streamingWrite: { support: 'supported' },
    pausableWrite: { support: 'supported' },
    createDirectory: { support: 'supported' },
  }));
  const createDirectory = vi.fn<StorageEntryOperations['createDirectory']>();
  const renameEntry = vi.fn<StorageEntryOperations['renameEntry']>();
  const copyWithin = vi.fn<StorageEntryOperations['copyWithin']>();
  const moveWithin = vi.fn<StorageEntryOperations['moveWithin']>();
  const deleteEntry = vi.fn<StorageEntryOperations['deleteEntry']>(async () => undefined);
  const entryOperations = {
    statEntry,
    inspectTransfer,
    inspectCrossConnectionTransfer,
    canonicalEntryKey,
    ancestorLocators,
    listDirectory,
    spaceSemantics,
    spaceCapabilities,
    createDirectory,
    renameEntry,
    copyWithin,
    moveWithin,
    deleteEntry,
    readEntry: vi.fn(),
  } as unknown as StorageEntryOperations;
  const directory: StorageTaskOperations['directory'] = (ref) =>
    createStorageDirectory(entryOperations, ref);

  const committedFiles = new Map<string, CommittedTransferFile>();
  const remainingDirsByPlan = new Map<string, SourceDirectoryCleanupEntry[]>();
  const providerOf = (connectionId: string) =>
    connectionId === internalLocalConnectionId ? ('local' as const) : ('google-drive' as const);

  const transfers = {
    prepare: vi.fn<TransferService['prepare']>(async (_owner, request) => {
      const planId = `plan-${request.entries[0]?.ref.locator ?? 'x'}`;
      if (request.entries.length === 1 && request.entries[0]!.kind === 'file') {
        const entry = request.entries[0]!;
        return {
          kind: 'single' as const,
          conflicts: [],
          work: {
            ref: { planId, itemId: 0 },
            mode: request.mode,
            sourceProvider: providerOf(request.sourceParent.connectionId),
            targetProvider: providerOf(request.targetParent.connectionId),
            item: {
              id: 0,
              entry,
              sourceParent: request.sourceParent,
              targetParent: request.targetParent,
              targetName: entry.name,
              relativePath: entry.name,
              replace: false,
            },
          },
        };
      }
      return {
        kind: 'batch' as const,
        prepared: {
          id: planId,
          mode: request.mode,
          sourceProvider: providerOf(request.sourceParent.connectionId),
          targetProvider: providerOf(request.targetParent.connectionId),
          targetParent: request.targetParent,
          conflicts: [],
          items: request.entries.map((entry, index) => ({
            id: index + 1,
            entry,
            sourceParent: request.sourceParent,
            targetParent: request.targetParent,
            targetName: entry.name,
            relativePath: entry.name,
            replace: false,
          })),
        },
      };
    }),
    confirmPlan: vi.fn(),
    discoverDirectory: vi.fn<TransferService['discoverDirectory']>(async () => ({ items: [] })),
    runWork: vi.fn<TransferService['runWork']>(async (_owner, ref) => {
      const key = `${ref.planId}:${ref.itemId}`;
      const existing = committedFiles.get(key);
      if (existing) {
        return {
          status: 'completed' as const,
          entry: existing.targetEntry,
          sourceSnapshot: existing.sourceSnapshot,
        };
      }
      const targetEntry: Entry = {
        ref: { connectionId: cloudConnectionB, spaceId: 'drive', locator: `copied-${key}` },
        name: 'report.txt',
        kind: 'file',
        capabilities: {},
      };
      const sourceSnapshot = {
        ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-1' },
        parent: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'a' },
        name: 'report.txt',
        kind: 'file' as const,
      };
      committedFiles.set(key, {
        itemId: ref.itemId,
        targetEntry,
        targetParent: { connectionId: cloudConnectionB, spaceId: 'drive', locator: 'b' },
        sourceSnapshot,
        sourceDeleted: false,
      });
      return { status: 'completed' as const, entry: targetEntry, sourceSnapshot };
    }),
    pauseWork: vi.fn(),
    canRetryWork: vi.fn(() => true),
    cancelWork: vi.fn(async () => undefined),
    cancelPlanItem: vi.fn(async () => undefined),
    getCommittedFile: vi.fn((_owner, ref) => committedFiles.get(`${ref.planId}:${ref.itemId}`)),
    markSourceDeleted: vi.fn((_owner, ref) => {
      const entry = committedFiles.get(`${ref.planId}:${ref.itemId}`);
      if (entry) entry.sourceDeleted = true;
    }),
    getRemainingSourceDirectories: vi.fn((_owner, planId) =>
      (remainingDirsByPlan.get(planId) ?? [])
        .filter((entry) => !entry.removed)
        .toSorted((left, right) => right.depth - left.depth),
    ),
    markSourceDirectoryDeleted: vi.fn((_owner, planId, ref) => {
      const targetKey = entryKey(ref);
      for (const entry of remainingDirsByPlan.get(planId) ?? []) {
        if (entryKey(entry.ref) === targetKey) entry.removed = true;
      }
    }),
    finishPlan: vi.fn(),
    releaseWork: vi.fn(async () => undefined),
    releasePlan: vi.fn(async () => undefined),
    cancelOwner: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };

  const dependencies: StorageTaskDependencies = {
    operations: {
      directory,
      inspectTransfer,
      inspectCrossConnectionTransfer,
      canonicalEntryKey,
      spaceSemantics,
      ancestorLocators,
      renameEntry,
      deleteEntry,
      statEntry,
    },
    transfers: transfers as unknown as TransferService,
  };

  return {
    dependencies,
    statEntry,
    inspectTransfer,
    inspectCrossConnectionTransfer,
    canonicalEntryKey,
    listDirectory,
    spaceSemantics,
    spaceCapabilities,
    createDirectory,
    copyWithin,
    moveWithin,
    deleteEntry,
    transfers,
    committedFiles,
    remainingDirsByPlan,
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

it('routes cloud-to-cloud copy paste through unified TransferService', async () => {
  const { dependencies, transfers } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const sourceParent: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'a' };
  const targetParent: EntryRef = { connectionId: cloudConnectionB, spaceId: 'drive', locator: 'b' };

  const response = await service.pasteEntries(1, {
    sourceParent,
    sourceDirectoryPath: 'Drive A',
    entries: [
      {
        ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-1' },
        name: 'report.txt',
        kind: 'file',
        size: 12,
        capabilities: { read: { support: 'supported' } },
      },
    ],
    targetParent,
    targetDirectoryPath: 'Drive B',
  });

  expect(response).toEqual({ status: 'started' });
  expect(transfers.prepare).toHaveBeenCalledWith(
    0,
    expect.objectContaining({ mode: 'copy', sourceParent, targetParent }),
  );
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));
  expect(service.getSnapshot().tasks[0]?.request).toMatchObject({
    type: 'transfer',
    input: {
      mode: 'copy',
      sourceProvider: 'google-drive',
      targetProvider: 'google-drive',
    },
  });

  await service.dispose();
});

it('rejects cross-connection self-containment such as two accounts on the same shared drive', async () => {
  const { dependencies, inspectCrossConnectionTransfer, transfers } = createMockTaskHost();
  inspectCrossConnectionTransfer.mockResolvedValueOnce({ selfContained: true });
  const service = new StorageTaskService(dependencies);
  const sourceParent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'shared-1',
    locator: 'root',
  };
  const targetParent: EntryRef = {
    connectionId: cloudConnectionB,
    spaceId: 'shared-1',
    locator: 'child-dir',
  };

  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent,
      sourceDirectoryPath: 'Shared / Root',
      entries: [
        {
          ref: { connectionId: cloudConnectionA, spaceId: 'shared-1', locator: 'shared-dir' },
          name: 'shared-dir',
          kind: 'directory',
          capabilities: { list: { support: 'supported' } },
        },
      ],
      targetParent,
      targetDirectoryPath: 'Shared / Root / shared-dir / child-dir',
    }),
  ).resolves.toEqual({ status: 'rejected', reason: 'self-containment' });
  expect(transfers.prepare).not.toHaveBeenCalled();

  await service.dispose();
});

it('enqueues same-directory single file copy immediately as a group and auto-renames during preparation', async () => {
  const { dependencies, listDirectory, copyWithin } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
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
  let resolveListing!: (page: EntryPage) => void;
  listDirectory.mockImplementationOnce(
    () =>
      new Promise<EntryPage>((resolve) => {
        resolveListing = resolve;
      }),
  );
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
  expect(service.getSnapshot().groups).toHaveLength(1);
  expect(service.getSnapshot().groups[0]?.request.kind).toBe('copy');
  expect(copyWithin).not.toHaveBeenCalled();

  await vi.waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
  resolveListing({ entries: [file] });
  await vi.waitFor(() => {
    expect(copyWithin).toHaveBeenCalledWith(file.ref, {
      parent,
      name: 'report - Copy.txt',
    });
  });
  expect(service.getSnapshot().tasks[0]?.request.type).toBe('copy');

  await service.dispose();
});

it('allocates distinct copy names for concurrent same-directory paste requests', async () => {
  const { dependencies, listDirectory, copyWithin } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
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
  listDirectory.mockResolvedValue({ entries: [file] } satisfies EntryPage);
  let copyCount = 0;
  copyWithin.mockImplementation(async (_ref, target) => ({
    ...file,
    ref: { ...file.ref, locator: `file-copy-${++copyCount}` },
    name: target.name,
  }));

  await Promise.all([
    service.pasteEntries(1, {
      sourceParent: parent,
      sourceDirectoryPath: 'My Drive / Folder',
      entries: [file],
      targetParent: parent,
      targetDirectoryPath: 'My Drive / Folder',
    }),
    service.pasteEntries(1, {
      sourceParent: parent,
      sourceDirectoryPath: 'My Drive / Folder',
      entries: [file],
      targetParent: parent,
      targetDirectoryPath: 'My Drive / Folder',
    }),
  ]);

  await vi.waitFor(() => {
    expect(copyWithin).toHaveBeenCalledTimes(2);
  });
  const names = copyWithin.mock.calls.map(([, target]) => target.name).sort();
  expect(names).toEqual(['report - Copy (2).txt', 'report - Copy.txt']);

  await service.dispose();
});

it('maps cross-directory single file copy directly to a standalone copy task without listing', async () => {
  const { dependencies, listDirectory, copyWithin } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const sourceParent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'folder-1',
  };
  const targetParent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'folder-2',
  };
  const file: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-1' },
    name: 'report.txt',
    kind: 'file',
    capabilities: { copyWithin: { support: 'supported' } },
  };
  copyWithin.mockResolvedValueOnce({
    ...file,
    ref: { ...file.ref, locator: 'file-2' },
  });

  const response = await service.pasteEntries(1, {
    sourceParent,
    sourceDirectoryPath: 'My Drive / Source',
    entries: [file],
    targetParent,
    targetDirectoryPath: 'My Drive / Target',
  });

  expect(response).toEqual({ status: 'started' });
  expect(listDirectory).not.toHaveBeenCalled();
  expect(service.getSnapshot().groups).toHaveLength(0);
  expect(service.getSnapshot().tasks[0]?.request.type).toBe('copy');
  await vi.waitFor(() => {
    expect(copyWithin).toHaveBeenCalledWith(file.ref, {
      parent: targetParent,
      name: 'report.txt',
    });
  });

  await service.dispose();
});

it('maps same-connection folder copy to a copy task group and copies children recursively', async () => {
  const { dependencies, listDirectory, createDirectory, copyWithin } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
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

it('rejects entries whose connectionId or spaceId does not match sourceParent', async () => {
  const { dependencies } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const sourceParent: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'a' };
  const targetParent: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'b' };

  await expect(
    service.pasteEntries(1, {
      sourceParent,
      sourceDirectoryPath: 'Drive A',
      entries: [
        {
          ref: {
            connectionId: internalLocalConnectionId,
            spaceId: 'local-1',
            locator: 'secret.txt',
          },
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
  const { dependencies, listDirectory, createDirectory, copyWithin } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
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

it('treats same-directory cut-paste as a no-op', async () => {
  const { dependencies, moveWithin } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const parent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'folder-1',
  };
  const file: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-1' },
    name: 'report.txt',
    kind: 'file',
    capabilities: { moveWithin: { support: 'supported' } },
  };

  const response = await service.pasteEntries(1, {
    mode: 'cut',
    sourceParent: parent,
    sourceDirectoryPath: 'My Drive / Folder',
    entries: [file],
    targetParent: parent,
    targetDirectoryPath: 'My Drive / Folder',
  });

  expect(response).toEqual({ status: 'started' });
  expect(moveWithin).not.toHaveBeenCalled();
  expect(service.getSnapshot().tasks).toHaveLength(0);
  expect(service.getSnapshot().groups).toHaveLength(0);

  await service.dispose();
});

it('maps same-connection cut-paste to native move tasks and emits removed and added changes', async () => {
  const { dependencies, moveWithin } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const changes: unknown[] = [];
  service.subscribe((event) => {
    if (event.type === 'directory-changed') changes.push(event.change);
  });
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
    capabilities: { moveWithin: { support: 'supported' } },
  };
  const movedEntry: Entry = { ...folder, ref: { ...folder.ref, locator: 'dir-1' } };
  moveWithin.mockResolvedValueOnce(movedEntry);

  const response = await service.pasteEntries(1, {
    mode: 'cut',
    sourceParent,
    sourceDirectoryPath: 'My Drive / Source',
    entries: [folder],
    targetParent,
    targetDirectoryPath: 'My Drive / Target',
  });

  expect(response).toEqual({ status: 'started' });
  await vi.waitFor(() => {
    expect(service.getSnapshot().tasks[0]?.status).toBe('completed');
  });
  expect(moveWithin).toHaveBeenCalledWith(folder.ref, { parent: targetParent, name: 'docs' });
  expect(service.getSnapshot().tasks[0]?.request.type).toBe('move');
  expect(changes).toEqual([
    { kind: 'removed', parent: sourceParent, ref: folder.ref },
    { kind: 'added', parent: targetParent, entry: movedEntry },
  ]);

  await service.dispose();
});

it('orchestrates cross-device move with verified source deletion, reports SourceCleanupFailed on failure, and retries only cleanup', async () => {
  const { dependencies, inspectTransfer, copyWithin, deleteEntry } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const sourceParent: EntryRef = {
    connectionId: internalLocalConnectionId,
    spaceId: 'vol-c',
    locator: '.',
  };
  const targetParent: EntryRef = {
    connectionId: internalLocalConnectionId,
    spaceId: 'vol-d',
    locator: '.',
  };
  const file: Entry = {
    ref: { connectionId: internalLocalConnectionId, spaceId: 'vol-c', locator: 'a.txt' },
    name: 'a.txt',
    kind: 'file',
    size: 10,
    revision: 'rev-a',
    capabilities: { copyWithin: { support: 'supported' }, remove: { support: 'supported' } },
  };

  inspectTransfer.mockResolvedValueOnce({ selfContained: false, moveStrategy: 'copy-delete' });
  copyWithin.mockResolvedValueOnce({
    ...file,
    ref: { connectionId: internalLocalConnectionId, spaceId: 'vol-d', locator: 'a.txt' },
  });
  deleteEntry
    .mockRejectedValueOnce(new StorageError('PermissionDenied'))
    .mockResolvedValueOnce(undefined);

  await service.pasteEntries(1, {
    mode: 'cut',
    sourceParent,
    sourceDirectoryPath: 'C:',
    entries: [file],
    targetParent,
    targetDirectoryPath: 'D:',
  });

  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('failed'));
  expect(service.getSnapshot().tasks[0]?.failure).toEqual({
    code: 'SourceCleanupFailed',
    message: { key: 'storage:copiedSourceNotRemoved' },
  });
  expect(service.getSnapshot().tasks[0]?.controls.canRetry).toBe(true);
  expect(copyWithin).toHaveBeenCalledTimes(1);
  expect(deleteEntry).toHaveBeenCalledWith(
    file.ref,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    { expectedRevision: 'rev-a', expectedSize: 10 },
  );

  // Retry must NOT copy again; it only retries removing the source file.
  await service.retry(service.getSnapshot().tasks[0]!.id);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));
  expect(copyWithin).toHaveBeenCalledTimes(1);
  expect(deleteEntry).toHaveBeenCalledTimes(2);

  // Copy failure must never attempt source deletion.
  deleteEntry.mockClear();
  const file2: Entry = {
    ...file,
    ref: { connectionId: internalLocalConnectionId, spaceId: 'vol-c', locator: 'b.txt' },
    name: 'b.txt',
  };
  inspectTransfer.mockResolvedValueOnce({ selfContained: false, moveStrategy: 'copy-delete' });
  copyWithin.mockRejectedValueOnce(new StorageError('InsufficientSpace'));

  await service.pasteEntries(1, {
    mode: 'cut',
    sourceParent,
    sourceDirectoryPath: 'C:',
    entries: [file2],
    targetParent,
    targetDirectoryPath: 'D:',
  });

  await vi.waitFor(() => expect(service.getSnapshot().tasks[1]?.status).toBe('failed'));
  expect(deleteEntry).not.toHaveBeenCalled();

  await service.dispose();
});

it('cleans up moved source directories bottom-up with onlyIfEmpty and retries only remaining directories', async () => {
  const { dependencies, transfers, remainingDirsByPlan, deleteEntry } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const sourceParent: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'a' };
  const targetParent: EntryRef = { connectionId: cloudConnectionB, spaceId: 'drive', locator: 'b' };
  const rootDir: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'dir-root' },
    name: 'docs',
    kind: 'directory',
    revision: 'rev-root',
    capabilities: { list: { support: 'supported' }, remove: { support: 'supported' } },
  };
  const subDirRef: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'drive',
    locator: 'dir-sub',
  };

  remainingDirsByPlan.set('plan-dir-root', [
    { ref: rootDir.ref, parent: sourceParent, depth: 0, revision: 'rev-root', removed: false },
    { ref: subDirRef, parent: rootDir.ref, depth: 1, revision: 'rev-sub', removed: false },
  ]);
  transfers.discoverDirectory.mockResolvedValueOnce({ items: [] });

  // Child directory deletes cleanly; parent fails (e.g. new file arrived) until retried.
  deleteEntry
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new StorageError('PreconditionFailed'))
    .mockResolvedValueOnce(undefined);

  await service.pasteEntries(1, {
    mode: 'cut',
    sourceParent,
    sourceDirectoryPath: 'Drive A',
    entries: [rootDir],
    targetParent,
    targetDirectoryPath: 'Drive B',
  });

  await vi.waitFor(() =>
    expect(service.getSnapshot().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'failed',
    }),
  );
  const cleanupTask = service.getSnapshot().tasks[0]!;
  expect(cleanupTask.request.type).toBe('cleanup-move-source');
  expect(cleanupTask.status).toBe('failed');
  expect(cleanupTask.failure).toEqual({
    code: 'SourceCleanupFailed',
    message: { key: 'storage:copiedSourceNotRemoved' },
  });
  expect(cleanupTask.controls.canRetry).toBe(true);
  // Deepest child deleted first, then parent attempted with onlyIfEmpty: true.
  expect(deleteEntry).toHaveBeenNthCalledWith(
    1,
    subDirRef,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    { onlyIfEmpty: true, expectedRevision: 'rev-sub' },
  );
  expect(deleteEntry).toHaveBeenNthCalledWith(
    2,
    rootDir.ref,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    { onlyIfEmpty: true, expectedRevision: 'rev-root' },
  );

  // Retry only attempts the remaining parent directory, never re-deleting the child.
  await service.retry(cleanupTask.id);
  await vi.waitFor(() =>
    expect(service.getSnapshot().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'completed',
    }),
  );
  expect(deleteEntry).toHaveBeenCalledTimes(3);
  expect(deleteEntry).toHaveBeenNthCalledWith(
    3,
    rootDir.ref,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    { onlyIfEmpty: true, expectedRevision: 'rev-root' },
  );

  await service.dispose();
});

it('rejects self-contained same-connection paste reported by inspectTransfer', async () => {
  const { dependencies, inspectTransfer, copyWithin } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const sourceParent: EntryRef = {
    connectionId: internalLocalConnectionId,
    spaceId: 'vol-c',
    locator: '.',
  };
  const targetParent: EntryRef = {
    connectionId: internalLocalConnectionId,
    spaceId: 'vol-c',
    locator: 'docs/sub',
  };
  const folder: Entry = {
    ref: { connectionId: internalLocalConnectionId, spaceId: 'vol-c', locator: 'docs' },
    name: 'docs',
    kind: 'directory',
    capabilities: { copyWithin: { support: 'supported' } },
  };
  inspectTransfer.mockResolvedValueOnce({ selfContained: true, moveStrategy: 'native' });

  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent,
      sourceDirectoryPath: 'C:',
      entries: [folder],
      targetParent,
      targetDirectoryPath: 'C:\\docs\\sub',
    }),
  ).resolves.toEqual({ status: 'rejected', reason: 'self-containment' });
  expect(inspectTransfer).toHaveBeenCalledWith(
    targetParent,
    [{ ref: folder.ref, kind: 'directory' }],
    'copy',
  );
  expect(copyWithin).not.toHaveBeenCalled();

  await service.dispose();
});

it('deletes verified source after cross-connection cut-paste transfer completes', async () => {
  const { dependencies, deleteEntry } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const sourceParent: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'a' };
  const targetParent: EntryRef = {
    connectionId: internalLocalConnectionId,
    spaceId: 'local-1',
    locator: '.',
  };
  const file: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-1' },
    name: 'report.txt',
    kind: 'file',
    size: 10,
    capabilities: { read: { support: 'supported' }, remove: { support: 'supported' } },
  };

  await service.pasteEntries(1, {
    mode: 'cut',
    sourceParent,
    sourceDirectoryPath: 'My Drive',
    entries: [file],
    targetParent,
    targetDirectoryPath: 'LocalTarget',
  });

  await vi.waitFor(() => {
    expect(service.getSnapshot().tasks[0]?.status).toBe('completed');
  });
  expect(deleteEntry).toHaveBeenCalledWith(
    file.ref,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    {},
  );

  await service.dispose();
});

it('allows moving duplicate-named entries concurrently when allowsDuplicateNames is true, and locks targets otherwise', async () => {
  const { dependencies, moveWithin, spaceSemantics } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
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
  spaceSemantics.mockResolvedValue({ allowsDuplicateNames: true });
  const dupA: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-a' },
    name: 'same.txt',
    kind: 'file',
    capabilities: { moveWithin: { support: 'supported' } },
  };
  const dupB: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'file-b' },
    name: 'same.txt',
    kind: 'file',
    capabilities: { moveWithin: { support: 'supported' } },
  };
  moveWithin.mockResolvedValueOnce(dupA).mockResolvedValueOnce(dupB);

  await service.pasteEntries(1, {
    mode: 'cut',
    sourceParent,
    sourceDirectoryPath: 'My Drive / Src',
    entries: [dupA, dupB],
    targetParent,
    targetDirectoryPath: 'My Drive / Dst',
  });

  await vi.waitFor(() => {
    expect(service.getSnapshot().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'completed',
    });
  });
  expect(service.getSnapshot().groups[0]?.summary.completed).toBe(2);
  expect(moveWithin).toHaveBeenCalledTimes(2);

  spaceSemantics.mockResolvedValue({ allowsDuplicateNames: false });
  let releasePending!: () => void;
  const pendingMove = new Promise<Entry>((resolve) => {
    releasePending = () =>
      resolve({
        ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'unique-1' },
        name: 'conflict.txt',
        kind: 'file',
        capabilities: {},
      });
  });
  const unique1: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'unique-1' },
    name: 'conflict.txt',
    kind: 'file',
    capabilities: { moveWithin: { support: 'supported' } },
  };
  const unique2: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'unique-2' },
    name: 'conflict.txt',
    kind: 'file',
    capabilities: { moveWithin: { support: 'supported' } },
  };
  const unique3: Entry = {
    ref: { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'unique-3' },
    name: 'other.txt',
    kind: 'file',
    capabilities: { moveWithin: { support: 'supported' } },
  };
  moveWithin.mockReturnValueOnce(pendingMove);

  await service.pasteEntries(1, {
    mode: 'cut',
    sourceParent,
    sourceDirectoryPath: 'Src',
    entries: [unique1],
    targetParent,
    targetDirectoryPath: 'Dst',
  });

  await expect(
    service.pasteEntries(1, {
      mode: 'cut',
      sourceParent,
      sourceDirectoryPath: 'Src',
      entries: [unique2, unique3],
      targetParent,
      targetDirectoryPath: 'Dst',
    }),
  ).rejects.toMatchObject({ code: 'PreconditionFailed' });

  releasePending();
  await service.dispose();
});

it('uses reported space case sensitivity rather than connectionId when allocating copy names', async () => {
  const { dependencies, listDirectory, copyWithin, spaceSemantics } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const parent: EntryRef = {
    connectionId: cloudConnectionA,
    spaceId: 'smb-share',
    locator: 'docs',
  };
  const source: Entry = {
    ref: { ...parent, locator: 'docs/report.txt' },
    name: 'report.txt',
    kind: 'file',
    capabilities: { copyWithin: { support: 'supported' } },
  };
  const existingDifferentCase: Entry = {
    ref: { ...parent, locator: 'docs/REPORT - COPY.TXT' },
    name: 'REPORT - COPY.TXT',
    kind: 'file',
    capabilities: { copyWithin: { support: 'supported' } },
  };

  listDirectory.mockResolvedValue({ entries: [source, existingDifferentCase] });
  copyWithin.mockImplementation(async (_ref, target) => ({
    ref: { ...target.parent, locator: `docs/${target.name}` },
    name: target.name,
    kind: 'file',
    capabilities: {},
  }));

  spaceSemantics.mockResolvedValue({ allowsDuplicateNames: false, caseSensitive: false });
  await service.pasteEntries(1, {
    mode: 'copy',
    sourceParent: parent,
    sourceDirectoryPath: '/docs',
    entries: [source],
    targetParent: parent,
    targetDirectoryPath: '/docs',
  });
  await vi.waitFor(() => {
    expect(service.getSnapshot().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'completed',
    });
  });
  expect(copyWithin).toHaveBeenLastCalledWith(source.ref, {
    parent,
    name: 'report - Copy (2).txt',
  });

  spaceSemantics.mockResolvedValue({ allowsDuplicateNames: false, caseSensitive: true });
  await service.pasteEntries(1, {
    mode: 'copy',
    sourceParent: parent,
    sourceDirectoryPath: '/docs',
    entries: [source],
    targetParent: parent,
    targetDirectoryPath: '/docs',
  });
  await vi.waitFor(() => {
    expect(service.getSnapshot().groups[1]?.state).toEqual({
      phase: 'settled',
      outcome: 'completed',
    });
  });
  expect(copyWithin).toHaveBeenLastCalledWith(source.ref, {
    parent,
    name: 'report - Copy.txt',
  });

  await service.dispose();
});

it('rejects pasting a directory into itself or a descendant via targetAncestors', async () => {
  const { dependencies } = createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const root: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'root' };
  const dir: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'dir-a' };
  const child: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'dir-b' };

  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: root,
      sourceDirectoryPath: 'My Drive',
      entries: [{ ref: dir, name: 'dir-a', kind: 'directory', capabilities: {} }],
      targetParent: child,
      targetDirectoryPath: 'My Drive / dir-a / dir-b',
      targetAncestors: [root, dir, child],
    }),
  ).resolves.toEqual({ status: 'rejected', reason: 'self-containment' });

  await service.dispose();
});

it('enforces route-specific capabilities in planPaste without blocking copyWithin or moveWithin on target write', async () => {
  const { dependencies, copyWithin, moveWithin, spaceCapabilities, statEntry } =
    createMockTaskHost();
  const service = new StorageTaskService(dependencies);
  const localRoot: EntryRef = {
    connectionId: internalLocalConnectionId,
    spaceId: 'local-1',
    locator: '.',
  };
  const remoteSrc: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'src' };
  const remoteDst: EntryRef = { connectionId: cloudConnectionA, spaceId: 'drive', locator: 'dst' };
  const localFile: Entry = {
    ref: { ...localRoot, locator: 'a.txt' },
    name: 'a.txt',
    kind: 'file',
    size: 5,
    capabilities: { read: { support: 'supported' } },
  };
  const remoteFile: Entry = {
    ref: { ...remoteSrc, locator: 'file-1' },
    name: 'report.txt',
    kind: 'file',
    size: 10,
    capabilities: {
      read: { support: 'supported' },
      copyWithin: { support: 'supported' },
      moveWithin: { support: 'supported' },
    },
  };
  const remoteFolder: Entry = {
    ref: { ...remoteSrc, locator: 'folder-1' },
    name: 'docs',
    kind: 'directory',
    capabilities: { moveWithin: { support: 'supported' } },
  };

  // Cross-connection requires target write and (for folders) createDirectory
  statEntry.mockResolvedValueOnce({
    ref: remoteDst,
    name: 'Dst',
    kind: 'directory',
    capabilities: { write: { support: 'unsupported' } },
  });
  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: localRoot,
      sourceDirectoryPath: 'C:',
      entries: [localFile],
      targetParent: remoteDst,
      targetDirectoryPath: 'Dst',
    }),
  ).resolves.toEqual({ status: 'rejected', reason: 'permission-denied' });

  statEntry.mockResolvedValueOnce({
    ref: remoteDst,
    name: 'Dst',
    kind: 'directory',
    capabilities: { write: { support: 'supported' }, createDirectory: { support: 'unsupported' } },
  });
  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: localRoot,
      sourceDirectoryPath: 'C:',
      entries: [
        {
          ...localFile,
          kind: 'directory',
          name: 'dir',
          capabilities: { list: { support: 'supported' } },
        },
      ],
      targetParent: remoteDst,
      targetDirectoryPath: 'Dst',
    }),
  ).resolves.toEqual({ status: 'rejected', reason: 'unsupported' });

  // Cloud -> Local also checks target write via unified capabilities
  statEntry.mockResolvedValueOnce({
    ref: localRoot,
    name: 'C:',
    kind: 'directory',
    capabilities: { write: { support: 'unsupported' } },
  });
  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: remoteSrc,
      sourceDirectoryPath: 'Src',
      entries: [remoteFile],
      targetParent: localRoot,
      targetDirectoryPath: 'C:',
    }),
  ).resolves.toEqual({ status: 'rejected', reason: 'permission-denied' });

  // Same-connection file copy uses copyWithin, not target space write
  spaceCapabilities.mockClear();
  copyWithin.mockResolvedValueOnce({ ...remoteFile, ref: { ...remoteDst, locator: 'file-2' } });
  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: remoteSrc,
      sourceDirectoryPath: 'Src',
      entries: [remoteFile],
      targetParent: remoteDst,
      targetDirectoryPath: 'Dst',
    }),
  ).resolves.toEqual({ status: 'started' });
  expect(spaceCapabilities).not.toHaveBeenCalled();

  // Same-connection file copy rejects when source copyWithin is unsupported
  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: remoteSrc,
      sourceDirectoryPath: 'Src',
      entries: [{ ...remoteFile, capabilities: { copyWithin: { support: 'unsupported' } } }],
      targetParent: remoteDst,
      targetDirectoryPath: 'Dst',
    }),
  ).resolves.toEqual({ status: 'rejected', reason: 'unsupported' });

  // Same-connection folder copy rejects when target space createDirectory is unsupported
  spaceCapabilities.mockResolvedValueOnce({ createDirectory: { support: 'unsupported' } });
  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: remoteSrc,
      sourceDirectoryPath: 'Src',
      entries: [remoteFolder],
      targetParent: remoteDst,
      targetDirectoryPath: 'Dst',
    }),
  ).resolves.toEqual({ status: 'rejected', reason: 'unsupported' });

  // Same-connection move uses moveWithin, not target space write or createDirectory
  spaceCapabilities.mockClear();
  moveWithin.mockResolvedValueOnce(remoteFolder);
  await expect(
    service.pasteEntries(1, {
      mode: 'cut',
      sourceParent: remoteSrc,
      sourceDirectoryPath: 'Src',
      entries: [remoteFolder],
      targetParent: remoteDst,
      targetDirectoryPath: 'Dst',
    }),
  ).resolves.toEqual({ status: 'started' });
  expect(spaceCapabilities).not.toHaveBeenCalled();

  // Same-connection move rejects when source moveWithin is unsupported
  await expect(
    service.pasteEntries(1, {
      mode: 'cut',
      sourceParent: remoteSrc,
      sourceDirectoryPath: 'Src',
      entries: [{ ...remoteFolder, capabilities: { moveWithin: { support: 'unsupported' } } }],
      targetParent: remoteDst,
      targetDirectoryPath: 'Dst',
    }),
  ).resolves.toEqual({ status: 'rejected', reason: 'unsupported' });

  await service.dispose();
});

it('reuses inspectLocalTransfer when dropping OS paths into a local directory for self-containment and same-directory copy', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-os-drop-local-'));
  await mkdir(join(temporary.path, 'docs', 'sub'), { recursive: true });
  await writeFile(join(temporary.path, 'note.txt'), 'hello');

  const { createStorageServices } = await import('../storage/storage-services');
  const { StoragePreferences } = await import('../storage/storage-preferences');
  const { createLocalStorageProvider } =
    await import('../storage/providers/local-storage-provider');
  const preferences = new StoragePreferences({ read: () => undefined, write() {} });
  const storage = createStorageServices({
    preferences,
    getAccounts: async () => {
      throw new Error('Accounts must not be initialized.');
    },
    logger: { event() {} },
    providers: [createLocalStorageProvider(async () => [temporary.path])],
    localVolumes: async () => [temporary.path],
  });
  const service = new StorageTaskService({
    operations: storage.operations,
    transfers: storage.transfers,
    localPathBridge: storage.localPathBridge,
  });

  try {
    const rootRef = localSpace(internalLocalConnectionId, temporary.path).root;
    const subRef: EntryRef = { ...rootRef, locator: 'docs/sub' };

    // Dropping docs/ into docs/sub/ must be rejected as self-containment.
    await expect(
      service.transferFromLocalPaths(1, {
        targetParent: subRef,
        targetDirectoryPath: join(temporary.path, 'docs', 'sub'),
        paths: [join(temporary.path, 'docs')],
      }),
    ).resolves.toEqual({ status: 'rejected', reason: 'self-containment' });

    // Dropping note.txt into its own directory auto-renames to "note - Copy.txt".
    await expect(
      service.transferFromLocalPaths(1, {
        targetParent: rootRef,
        targetDirectoryPath: temporary.path,
        paths: [join(temporary.path, 'note.txt')],
      }),
    ).resolves.toEqual({ status: 'started' });

    await vi.waitFor(() =>
      expect(service.getSnapshot().groups[0]?.state).toEqual({
        phase: 'settled',
        outcome: 'completed',
      }),
    );
    expect(await readFile(join(temporary.path, 'note - Copy.txt'), 'utf8')).toBe('hello');
  } finally {
    await service.dispose();
    await storage.dispose();
  }
});
