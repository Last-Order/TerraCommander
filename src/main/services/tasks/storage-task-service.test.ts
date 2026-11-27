import { expect, it, vi } from 'vitest';
import { StorageError } from '@main/storage';
import { deferred } from '@main/testing/deferred';
import { entryKey, type Entry, type EntryRef } from '@shared/storage';
import type { StorageTaskEvent } from '@shared/tasks';
import { createStorageDirectory } from '../storage/storage-directory';
import type { StorageEntryOperations } from '../storage/storage-entry-operations';
import type { TransferService } from '../transfers/transfer-service';
import type { TransferProgress, TransferRunResult } from '../transfers/transfer-types';
import {
  StorageTaskService,
  type StorageTaskDependencies,
  type StorageTaskOperations,
} from './storage-task-service';

const connectionId = '5e45885a-89f0-462e-9821-7195cba174e5';
const targetConnectionId = 'local';
const parent: EntryRef = { connectionId, spaceId: 'drive', locator: 'folder' };
const targetParent: EntryRef = { connectionId: targetConnectionId, spaceId: 'vol-d', locator: '.' };
const fileEntry: Entry = {
  ref: { connectionId, spaceId: 'drive', locator: 'file-1' },
  name: 'report.txt',
  kind: 'file',
  size: 10,
  capabilities: {
    read: { support: 'supported' },
    rename: { support: 'supported' },
    remove: { support: 'supported' },
  },
};
const folderEntry: Entry = {
  ref: { connectionId, spaceId: 'drive', locator: 'dir-1' },
  name: 'docs',
  kind: 'directory',
  capabilities: { list: { support: 'supported' }, remove: { support: 'supported' } },
};
const committedTargetEntry: Entry = {
  ref: { ...targetParent, locator: 'report.txt' },
  name: 'report.txt',
  kind: 'file',
  size: 10,
  capabilities: {},
};

function setup() {
  const runWork = vi.fn<TransferService['runWork']>(async () => ({
    status: 'completed',
    entry: committedTargetEntry,
    sourceSnapshot: {
      ref: fileEntry.ref,
      parent,
      name: fileEntry.name,
      kind: 'file',
      size: fileEntry.size,
    },
  }));
  const transfers = {
    prepare: vi.fn<TransferService['prepare']>(async (_owner, request) => {
      if (request.entries.length === 1 && request.entries[0]!.kind === 'file') {
        const entry = request.entries[0]!;
        return {
          kind: 'single' as const,
          conflicts: [],
          work: {
            ref: { planId: 'single-plan', itemId: 0 },
            mode: request.mode,
            sourceProvider: 'google-drive' as const,
            targetProvider: 'local' as const,
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
          id: 'batch-1',
          mode: request.mode,
          sourceProvider: 'google-drive' as const,
          targetProvider: 'local' as const,
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
    runWork,
    pauseWork: vi.fn(),
    canRetryWork: vi.fn(() => true),
    cancelWork: vi.fn(async () => undefined),
    cancelPlanItem: vi.fn(async () => undefined),
    getCommittedFile: vi.fn(() => undefined),
    markSourceDeleted: vi.fn(),
    getRemainingSourceDirectories: vi.fn(() => []),
    markSourceDirectoryDeleted: vi.fn(),
    finishPlan: vi.fn(),
    releaseWork: vi.fn(async () => undefined),
    releasePlan: vi.fn(async () => undefined),
    cancelOwner: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };

  const createDirectory = vi.fn(async ({ name }: { name: string }) => ({
    ...folderEntry,
    name,
  }));
  const renameEntry = vi.fn(async () => ({ ...fileEntry, name: 'final.txt' }));
  const deleteEntry = vi.fn(async () => undefined);
  const copyWithin = vi.fn(async () => ({ ...fileEntry, name: 'report.txt' }));
  const moveWithin = vi.fn(async () => ({ ...fileEntry, name: 'report.txt' }));
  const spaceSemantics = vi.fn<StorageEntryOperations['spaceSemantics']>(async () => undefined);
  const spaceCapabilities = vi.fn<StorageEntryOperations['spaceCapabilities']>(async () => ({
    write: { support: 'supported' },
    streamingWrite: { support: 'supported' },
    pausableWrite: { support: 'supported' },
    createDirectory: { support: 'supported' },
  }));
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
  const inspectTransfer = vi.fn<StorageEntryOperations['inspectTransfer']>(async () => ({
    selfContained: false,
    moveStrategy: 'native',
  }));
  const inspectCrossConnectionTransfer = vi.fn<
    StorageEntryOperations['inspectCrossConnectionTransfer']
  >(async () => ({ selfContained: false }));
  const canonicalEntryKey = vi.fn<StorageEntryOperations['canonicalEntryKey']>(async (ref) =>
    entryKey(ref),
  );
  const ancestorLocators = vi.fn<StorageEntryOperations['ancestorLocators']>(async () => undefined);

  const entryOperations = {
    createDirectory,
    renameEntry,
    deleteEntry,
    copyWithin,
    moveWithin,
    spaceSemantics,
    spaceCapabilities,
    listDirectory: vi.fn(async () => ({ entries: [] })),
    inspectTransfer,
    inspectCrossConnectionTransfer,
    canonicalEntryKey,
    ancestorLocators,
    statEntry,
    readEntry: vi.fn(),
  } as unknown as StorageEntryOperations;
  const operations: StorageTaskOperations = {
    directory: (ref) => createStorageDirectory(entryOperations, ref),
    inspectTransfer,
    inspectCrossConnectionTransfer,
    canonicalEntryKey,
    spaceSemantics,
    ancestorLocators,
    renameEntry,
    deleteEntry,
    statEntry,
  };
  const dependencies: StorageTaskDependencies = {
    operations,
    transfers: transfers as unknown as TransferService,
  };
  const service = new StorageTaskService(dependencies);
  const events: StorageTaskEvent[] = [];
  service.subscribe((event) => events.push(event));
  return {
    service,
    operations,
    transfers,
    createDirectory,
    renameEntry,
    deleteEntry,
    copyWithin,
    moveWithin,
    spaceSemantics,
    ancestorLocators,
    events,
  };
}

it('executes create-directory tasks, prevents concurrent name conflicts, and maps errors', async () => {
  const { service, createDirectory, events } = setup();
  const pending = deferred<Entry>();
  createDirectory.mockImplementationOnce(() => pending.promise);

  expect(
    await service.enqueueCreateDirectory({ parent, name: 'Projects', directoryPath: '/docs' }),
  ).toBe(true);
  expect(
    await service.enqueueCreateDirectory({ parent, name: 'Projects', directoryPath: '/docs' }),
  ).toBe(false);

  const created = { ...folderEntry, name: 'Projects' };
  pending.resolve(created);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));
  expect(createDirectory).toHaveBeenCalledWith({ parent, name: 'Projects' });
  expect(events).toContainEqual({
    type: 'directory-changed',
    change: { kind: 'added', parent, entry: created },
  });

  createDirectory.mockRejectedValueOnce(new StorageError('InvalidArgument'));
  expect(
    await service.enqueueCreateDirectory({ parent, name: 'bad', directoryPath: '/docs' }),
  ).toBe(true);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[1]?.status).toBe('failed'));
  expect(service.getSnapshot().tasks[1]?.failure).toEqual({
    code: 'InvalidArgument',
    message: { key: 'storage:invalidEntryName' },
  });

  createDirectory.mockRejectedValueOnce(new StorageError('AuthRequired'));
  expect(
    await service.enqueueCreateDirectory({ parent, name: 'Auth', directoryPath: '/docs' }),
  ).toBe(true);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[2]?.status).toBe('failed'));
  expect(events).toContainEqual({ type: 'auth-required', connectionId });

  await service.dispose();
});

it('executes rename and delete tasks, projects directory changes, and maps validation errors', async () => {
  const { service, renameEntry, deleteEntry, events } = setup();

  expect(
    await service.enqueueRename({
      parent,
      entry: fileEntry,
      name: 'final.txt',
      directoryPath: '/docs',
    }),
  ).toBe(true);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));
  expect(renameEntry).toHaveBeenCalledWith(fileEntry.ref, 'final.txt');
  expect(events).toContainEqual({
    type: 'directory-changed',
    change: {
      kind: 'renamed',
      parent,
      previous: fileEntry.ref,
      entry: { ...fileEntry, name: 'final.txt' },
    },
  });

  renameEntry.mockRejectedValueOnce(new StorageError('InvalidArgument'));
  await service.enqueueRename({ parent, entry: fileEntry, name: 'bad', directoryPath: '/docs' });
  await vi.waitFor(() => expect(service.getSnapshot().tasks[1]?.status).toBe('failed'));
  expect(service.getSnapshot().tasks[1]?.failure).toEqual({
    code: 'InvalidArgument',
    message: { key: 'storage:invalidEntryName' },
  });

  deleteEntry.mockRejectedValueOnce(new StorageError('AuthRequired'));
  await service.enqueueDelete({ parent, entries: [fileEntry], directoryPath: '/docs' });
  await vi.waitFor(() => expect(service.getSnapshot().tasks[2]?.status).toBe('failed'));
  expect(events).toContainEqual({ type: 'auth-required', connectionId });

  await service.dispose();
});

it('creates a delete task group for multiple entries including folders and rejects conflicting batches', async () => {
  const { service, deleteEntry, events } = setup();
  const folderToDelete: Entry = {
    ref: { connectionId, spaceId: 'drive', locator: 'folder-1' },
    name: 'Folder',
    kind: 'directory',
    capabilities: { remove: { support: 'supported' } },
  };
  const firstDone = deferred<undefined>();
  deleteEntry.mockImplementationOnce(() => firstDone.promise);

  expect(
    await service.enqueueDelete({
      parent,
      entries: [fileEntry, folderToDelete],
      directoryPath: '/docs',
    }),
  ).toBe(true);
  expect(
    await service.enqueueDelete({
      parent,
      entries: [folderToDelete],
      directoryPath: '/docs',
    }),
  ).toBe(false);

  const activeSnapshot = service.getSnapshot();
  expect(activeSnapshot.groups).toHaveLength(1);
  expect(activeSnapshot.groups[0]).toMatchObject({
    sealed: true,
    request: {
      kind: 'delete',
      input: {
        names: [fileEntry.name, 'Folder'],
        directoryPath: '/docs',
        entries: [fileEntry.ref, folderToDelete.ref],
      },
    },
  });

  firstDone.resolve(undefined);
  await vi.waitFor(() =>
    expect(service.getSnapshot().tasks.every((task) => task.status === 'completed')).toBe(true),
  );
  expect(deleteEntry).toHaveBeenCalledWith(fileEntry.ref);
  expect(deleteEntry).toHaveBeenCalledWith(folderToDelete.ref);
  expect(events).toContainEqual({
    type: 'directory-changed',
    change: { kind: 'removed', parent, ref: fileEntry.ref },
  });
  expect(events).toContainEqual({
    type: 'directory-changed',
    change: { kind: 'removed', parent, ref: folderToDelete.ref },
  });

  await service.dispose();
});

it('handles single-file transfer overwrite confirmation with reservation lock handoff, pause/resume, retry, and strips workRef', async () => {
  const { service, transfers, events } = setup();
  transfers.prepare.mockResolvedValueOnce({
    kind: 'single',
    conflicts: ['report.txt'],
    work: {
      ref: { planId: 'single-plan', itemId: 0 },
      mode: 'copy',
      sourceProvider: 'google-drive',
      targetProvider: 'local',
      item: {
        id: 0,
        entry: fileEntry,
        sourceParent: parent,
        targetParent,
        targetName: fileEntry.name,
        relativePath: fileEntry.name,
        replace: false,
      },
    },
  });

  const conflict = await service.pasteEntries(1, {
    mode: 'copy',
    sourceParent: parent,
    sourceDirectoryPath: '/docs',
    entries: [fileEntry],
    targetParent,
    targetDirectoryPath: 'D:\\Downloads',
  });
  expect(conflict.status).toBe('conflict');
  if (conflict.status !== 'conflict') throw new Error('Expected conflict');
  expect(conflict.conflicts).toBeUndefined();

  // While confirmation is pending, another operation on the reserved target slot must be blocked.
  expect(
    await service.enqueueCreateDirectory({
      parent: targetParent,
      name: 'report.txt',
      directoryPath: 'D:\\Downloads',
    }),
  ).toBe(false);

  // Wrong owner cannot confirm.
  await expect(service.confirmTransfer(2, conflict.confirmationId)).rejects.toMatchObject({
    code: 'InvalidArgument',
  });

  const firstRun = deferred<TransferRunResult>();
  const retryRun = deferred<TransferRunResult>();
  transfers.runWork
    .mockImplementationOnce(async (_owner, _ref, options) => {
      options.onProgress({
        controls: { cancellable: true, pausable: true },
        stage: 'transferring',
        completedBytes: 5,
        totalBytes: 10,
        bytesPerSecond: 20,
      });
      return firstRun.promise;
    })
    .mockImplementationOnce(async () => retryRun.promise);

  await service.confirmTransfer(1, conflict.confirmationId);
  expect(transfers.confirmPlan).toHaveBeenCalledWith(0, 'single-plan');

  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.controls.canPause).toBe(true));
  const projectedInput = service.getSnapshot().tasks[0]!.request.input;
  expect('workRef' in projectedInput).toBe(false);

  firstRun.resolve({ status: 'paused', completedBytes: 5, totalBytes: 10 });
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('paused'));

  service.resume(service.getSnapshot().tasks[0]!.id);
  retryRun.reject(new StorageError('NetworkError'));
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('failed'));
  expect(service.getSnapshot().tasks[0]?.controls.canRetry).toBe(true);

  await service.retry(service.getSnapshot().tasks[0]!.id);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));
  expect(events).toContainEqual({
    type: 'directory-changed',
    change: { kind: 'added', parent: targetParent, entry: committedTargetEntry },
  });

  await service.dispose();
});

it('runs DFS transfer batch discovery, handles non-fatal issues, and releases only uncommitted confirmations on owner reset', async () => {
  const { service, transfers } = setup();
  const childFile: Entry = {
    ...fileEntry,
    ref: { ...fileEntry.ref, locator: 'child-1' },
    name: 'a.txt',
  };
  const nestedDir: Entry = {
    ...folderEntry,
    ref: { ...folderEntry.ref, locator: 'sub-1' },
    name: 'sub',
  };

  const activeTransfer = deferred<TransferRunResult>();
  transfers.runWork.mockImplementationOnce(() => activeTransfer.promise);
  transfers.discoverDirectory
    .mockResolvedValueOnce({
      items: [
        {
          id: 2,
          entry: childFile,
          sourceParent: folderEntry.ref,
          targetParent: { ...targetParent, locator: 'docs' },
          targetName: 'a.txt',
          relativePath: 'docs/a.txt',
          replace: false,
        },
        {
          id: 3,
          entry: nestedDir,
          sourceParent: folderEntry.ref,
          targetParent: { ...targetParent, locator: 'docs' },
          targetName: 'sub',
          relativePath: 'docs/sub',
          replace: false,
        },
      ],
    })
    .mockRejectedValueOnce(new StorageError('PermissionDenied'));

  const started = await service.pasteEntries(1, {
    mode: 'copy',
    sourceParent: parent,
    sourceDirectoryPath: '/docs',
    entries: [folderEntry],
    targetParent,
    targetDirectoryPath: 'D:\\Downloads',
  });
  expect(started).toEqual({ status: 'started' });

  await vi.waitFor(() => {
    const snapshot = service.getSnapshot();
    const group = snapshot.groups[0];
    expect(group?.sealed).toBe(true);
    expect(group?.preparation.issues).toHaveLength(1);
    expect(group?.preparation.issues[0]?.failure.code).toBe('PermissionDenied');
    expect(group?.request).toEqual({
      kind: 'transfer',
      input: {
        mode: 'copy',
        sourceProvider: 'google-drive',
        targetProvider: 'local',
        names: [folderEntry.name],
        sourcePath: '/docs',
        destinationPath: 'D:\\Downloads',
        sourceEntries: [folderEntry.ref],
        targetParent,
      },
    });
    expect(snapshot.tasks[0]).not.toHaveProperty('memberKey');
  });

  // Uncommitted confirmation from owner 1 is released on owner reset without touching active task.
  const otherEntry: Entry = {
    ...fileEntry,
    ref: { ...fileEntry.ref, locator: 'other' },
    name: 'other.txt',
  };
  transfers.prepare.mockResolvedValueOnce({
    kind: 'batch',
    prepared: {
      id: 'batch-pending',
      mode: 'copy',
      sourceProvider: 'google-drive',
      targetProvider: 'local',
      targetParent,
      conflicts: ['other.txt'],
      items: [
        {
          id: 1,
          entry: otherEntry,
          sourceParent: parent,
          targetParent,
          targetName: 'other.txt',
          relativePath: 'other.txt',
          replace: false,
        },
      ],
    },
  });
  const pendingConflict = await service.pasteEntries(1, {
    mode: 'copy',
    sourceParent: parent,
    sourceDirectoryPath: '/docs',
    entries: [otherEntry],
    targetParent,
    targetDirectoryPath: 'D:\\Downloads',
  });
  expect(pendingConflict.status).toBe('conflict');

  service.cancelOwnerConfirmations(1);
  await vi.waitFor(() => expect(transfers.releasePlan).toHaveBeenCalledWith(0, 'batch-pending'));
  expect(service.getSnapshot().tasks[0]?.status).toBe('running');

  activeTransfer.resolve({
    status: 'completed',
    entry: committedTargetEntry,
    sourceSnapshot: {
      ref: childFile.ref,
      parent: folderEntry.ref,
      name: childFile.name,
      kind: 'file',
      size: childFile.size,
    },
  });
  await vi.waitFor(() =>
    expect(service.getSnapshot().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'partial',
    }),
  );
  expect(transfers.finishPlan).toHaveBeenCalledWith(0, 'batch-1');

  service.clearFinished();
  expect(service.getSnapshot().tasks).toHaveLength(0);
  expect(service.getSnapshot().groups).toHaveLength(0);
  expect(transfers.releasePlan).toHaveBeenCalledWith(0, 'batch-1');
});

it('rejects overlapping active transfer locks and emits auth-required on fatal discovery errors', async () => {
  const { service, transfers, events } = setup();
  transfers.discoverDirectory.mockRejectedValueOnce(new StorageError('AuthRequired'));

  await service.pasteEntries(1, {
    mode: 'copy',
    sourceParent: parent,
    sourceDirectoryPath: '/docs',
    entries: [folderEntry],
    targetParent,
    targetDirectoryPath: 'D:\\Downloads',
  });
  await vi.waitFor(() =>
    expect(service.getSnapshot().groups[0]?.preparation.status).toBe('failed'),
  );
  expect(events).toContainEqual({ type: 'auth-required', connectionId });

  const blocked = deferred<TransferRunResult>();
  transfers.runWork.mockImplementationOnce(() => blocked.promise);
  await service.pasteEntries(1, {
    mode: 'copy',
    sourceParent: parent,
    sourceDirectoryPath: '/docs',
    entries: [fileEntry],
    targetParent,
    targetDirectoryPath: 'D:\\Downloads',
  });

  transfers.prepare.mockResolvedValueOnce({
    kind: 'single',
    conflicts: [],
    work: {
      ref: { planId: 'single-plan-2', itemId: 0 },
      mode: 'copy',
      sourceProvider: 'google-drive',
      targetProvider: 'local',
      item: {
        id: 0,
        entry: fileEntry,
        sourceParent: parent,
        targetParent: { ...targetParent, locator: 'other' },
        targetName: fileEntry.name,
        relativePath: fileEntry.name,
        replace: false,
      },
    },
  });
  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: parent,
      sourceDirectoryPath: '/docs',
      entries: [fileEntry],
      targetParent: { ...targetParent, locator: 'other' },
      targetDirectoryPath: 'D:\\Other',
    }),
  ).rejects.toMatchObject({ code: 'PreconditionFailed' });
  expect(transfers.releaseWork).toHaveBeenCalledWith(0, { planId: 'single-plan-2', itemId: 0 });

  blocked.resolve({
    status: 'completed',
    entry: committedTargetEntry,
    sourceSnapshot: {
      ref: fileEntry.ref,
      parent,
      name: fileEntry.name,
      kind: 'file',
      size: fileEntry.size,
    },
  });
  await service.dispose();
});

it('emits lightweight task-progress events with neutral stage keys and tracks busy directoryEffects', async () => {
  const { service, transfers, events } = setup();
  const finish = deferred<TransferRunResult>();
  let reportProgress: ((progress: TransferProgress) => void) | undefined;
  transfers.runWork.mockImplementationOnce(async (_owner, _ref, options) => {
    reportProgress = options.onProgress;
    options.onProgress({
      stage: 'transferring',
      completedBytes: 10,
      totalBytes: 100,
      controls: { cancellable: true, pausable: true },
    });
    return finish.promise;
  });

  try {
    await expect(
      service.pasteEntries(1, {
        sourceParent: parent,
        sourceDirectoryPath: '/Drive',
        entries: [fileEntry],
        targetParent,
        targetDirectoryPath: 'D:\\Downloads',
      }),
    ).resolves.toEqual({ status: 'started' });
    expect(transfers.prepare).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ mode: 'copy', sourceParent: parent, targetParent }),
    );

    await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.controls.canPause).toBe(true));
    expect(service.getSnapshot().tasks[0]?.request).toMatchObject({
      type: 'transfer',
      input: { mode: 'copy', sourceProvider: 'google-drive', targetProvider: 'local' },
    });
    expect(service.getSnapshot().directoryEffects).toEqual({
      busyEntries: [fileEntry.ref],
      renames: [],
    });

    const beforeTicks = events.length;
    reportProgress?.({
      stage: 'transferring',
      completedBytes: 40,
      totalBytes: 100,
      bytesPerSecond: 2048,
      controls: { cancellable: true, pausable: true },
    });
    reportProgress?.({
      stage: 'finalizing',
      completedBytes: 100,
      totalBytes: 100,
      bytesPerSecond: 4096,
      controls: { cancellable: false, pausable: false },
    });

    const tickEvents = events.slice(beforeTicks).filter((e) => e.type === 'task-progress');
    expect(tickEvents).toEqual([
      {
        type: 'task-progress',
        taskId: 1,
        progress: {
          kind: 'determinate',
          completed: 40,
          total: 100,
          unit: 'bytes',
          stage: { key: 'storage:transferring' },
          bytesPerSecond: 2048,
        },
      },
      {
        type: 'task-progress',
        taskId: 1,
        progress: {
          kind: 'determinate',
          completed: 100,
          total: 100,
          unit: 'bytes',
          stage: { key: 'storage:transferFinalizing' },
          bytesPerSecond: 4096,
        },
      },
    ]);

    finish.resolve({
      status: 'completed',
      entry: committedTargetEntry,
      sourceSnapshot: {
        ref: fileEntry.ref,
        parent,
        name: fileEntry.name,
        kind: 'file',
        size: fileEntry.size,
      },
    });
    await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));
    expect(service.getSnapshot().directoryEffects).toEqual({
      busyEntries: [],
      renames: [],
    });
  } finally {
    await service.dispose();
  }
});

it('blocks overlapping slot operations between delete, rename, create-directory, and copy', async () => {
  const { service, deleteEntry, renameEntry } = setup();
  const pendingDelete = deferred<undefined>();
  deleteEntry.mockImplementationOnce(() => pendingDelete.promise);

  expect(
    await service.enqueueDelete({ parent, entries: [fileEntry], directoryPath: '/docs' }),
  ).toBe(true);
  expect(
    await service.enqueueCreateDirectory({ parent, name: fileEntry.name, directoryPath: '/docs' }),
  ).toBe(false);
  const otherSource: Entry = {
    ref: { connectionId, spaceId: 'drive', locator: 'other-file' },
    name: fileEntry.name,
    kind: 'file',
    capabilities: { copyWithin: { support: 'supported' } },
  };
  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: { connectionId, spaceId: 'drive', locator: 'other-folder' },
      sourceDirectoryPath: '/other',
      entries: [otherSource],
      targetParent: parent,
      targetDirectoryPath: '/docs',
    }),
  ).rejects.toMatchObject({ code: 'AlreadyExists' });

  pendingDelete.resolve(undefined);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));

  const pendingRename = deferred<Entry>();
  renameEntry.mockImplementationOnce(() => pendingRename.promise);
  expect(
    await service.enqueueRename({
      parent,
      entry: fileEntry,
      name: 'renamed.txt',
      directoryPath: '/docs',
    }),
  ).toBe(true);
  expect(
    await service.enqueueCreateDirectory({ parent, name: fileEntry.name, directoryPath: '/docs' }),
  ).toBe(false);
  expect(
    await service.enqueueCreateDirectory({ parent, name: 'renamed.txt', directoryPath: '/docs' }),
  ).toBe(false);

  pendingRename.resolve({ ...fileEntry, name: 'renamed.txt' });
  await vi.waitFor(() => expect(service.getSnapshot().tasks[1]?.status).toBe('completed'));
  await service.dispose();
});

it('allows batch deleting duplicate-named entries when allowsDuplicateNames is true', async () => {
  const { service, deleteEntry, spaceSemantics } = setup();
  spaceSemantics.mockResolvedValue({ allowsDuplicateNames: true });
  const dupA: Entry = {
    ...fileEntry,
    ref: { connectionId, spaceId: 'drive', locator: 'dup-a' },
    name: 'same.txt',
  };
  const dupB: Entry = {
    ...fileEntry,
    ref: { connectionId, spaceId: 'drive', locator: 'dup-b' },
    name: 'same.txt',
  };

  expect(
    await service.enqueueDelete({ parent, entries: [dupA, dupB], directoryPath: '/docs' }),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(service.getSnapshot().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'completed',
    }),
  );
  expect(deleteEntry).toHaveBeenCalledTimes(2);
  await service.dispose();
});

it('normalizes slot conflict keys according to reported space case sensitivity', async () => {
  const { service, createDirectory, spaceSemantics } = setup();
  const pendingInsensitive = deferred<Entry>();
  createDirectory.mockImplementationOnce(() => pendingInsensitive.promise);
  spaceSemantics.mockResolvedValue({ allowsDuplicateNames: false, caseSensitive: false });

  expect(
    await service.enqueueCreateDirectory({
      parent,
      name: 'Projects',
      directoryPath: '/docs',
    }),
  ).toBe(true);
  expect(
    await service.enqueueCreateDirectory({
      parent,
      name: 'projects',
      directoryPath: '/docs',
    }),
  ).toBe(false);

  pendingInsensitive.resolve({ ...folderEntry, name: 'Projects' });
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));

  const pendingSensitiveA = deferred<Entry>();
  const pendingSensitiveB = deferred<Entry>();
  createDirectory
    .mockImplementationOnce(() => pendingSensitiveA.promise)
    .mockImplementationOnce(() => pendingSensitiveB.promise);
  spaceSemantics.mockResolvedValue({ allowsDuplicateNames: false, caseSensitive: true });

  expect(
    await service.enqueueCreateDirectory({
      parent,
      name: 'Archive',
      directoryPath: '/docs',
    }),
  ).toBe(true);
  expect(
    await service.enqueueCreateDirectory({
      parent,
      name: 'archive',
      directoryPath: '/docs',
    }),
  ).toBe(true);

  pendingSensitiveA.resolve({ ...folderEntry, name: 'Archive' });
  pendingSensitiveB.resolve({ ...folderEntry, name: 'archive' });
  await vi.waitFor(() => {
    const tasks = service.getSnapshot().tasks;
    expect(tasks[1]?.status).toBe('completed');
    expect(tasks[2]?.status).toBe('completed');
  });
  await service.dispose();
});

it('blocks same-name create-directory and rename while a transfer awaits overwrite confirmation', async () => {
  const { service, transfers, spaceSemantics } = setup();
  spaceSemantics.mockResolvedValue({ allowsDuplicateNames: false, caseSensitive: false });
  transfers.prepare.mockResolvedValueOnce({
    kind: 'single',
    conflicts: ['Report.txt'],
    work: {
      ref: { planId: 'confirm-plan', itemId: 0 },
      mode: 'copy',
      sourceProvider: 'google-drive',
      targetProvider: 'local',
      item: {
        id: 0,
        entry: fileEntry,
        sourceParent: parent,
        targetParent,
        targetName: 'Report.txt',
        relativePath: 'Report.txt',
        replace: true,
      },
    },
  });

  const pending = await service.pasteEntries(1, {
    mode: 'copy',
    sourceParent: parent,
    sourceDirectoryPath: '/docs',
    entries: [fileEntry],
    targetParent,
    targetDirectoryPath: 'D:\\Downloads',
  });
  expect(pending).toMatchObject({ status: 'conflict' });
  if (pending.status !== 'conflict') throw new Error('Expected conflict confirmation');

  expect(
    await service.enqueueCreateDirectory({
      parent: targetParent,
      name: 'report.txt',
      directoryPath: 'D:\\Downloads',
    }),
  ).toBe(false);
  expect(
    await service.enqueueRename({
      parent: targetParent,
      entry: {
        ref: { ...targetParent, locator: 'existing.txt' },
        name: 'existing.txt',
        kind: 'file',
        capabilities: { rename: { support: 'supported' } },
      },
      name: 'REPORT.TXT',
      directoryPath: 'D:\\Downloads',
    }),
  ).toBe(false);

  await service.cancelTransferConfirmation(1, pending.confirmationId);
  expect(
    await service.enqueueCreateDirectory({
      parent: targetParent,
      name: 'report.txt',
      directoryPath: 'D:\\Downloads',
    }),
  ).toBe(true);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));
  await service.dispose();
});

it('runs sibling transfers concurrently under shared ancestor locks while blocking ancestor rename', async () => {
  const { service, transfers, ancestorLocators } = setup();
  const nestedTargetParent: EntryRef = {
    connectionId: targetConnectionId,
    spaceId: 'vol-d',
    locator: 'projects/2026',
  };
  const ancestorDirRef: EntryRef = {
    connectionId: targetConnectionId,
    spaceId: 'vol-d',
    locator: 'projects',
  };
  const rootDirRef: EntryRef = {
    connectionId: targetConnectionId,
    spaceId: 'vol-d',
    locator: '.',
  };
  ancestorLocators.mockResolvedValue(['projects/2026', 'projects', '.']);

  const firstEntry: Entry = {
    ...fileEntry,
    ref: { connectionId, spaceId: 'drive', locator: 'file-a' },
    name: 'alpha.txt',
  };
  const secondEntry: Entry = {
    ...fileEntry,
    ref: { connectionId, spaceId: 'drive', locator: 'file-b' },
    name: 'beta.txt',
  };
  const firstRun = deferred<TransferRunResult>();
  const secondRun = deferred<TransferRunResult>();
  transfers.runWork
    .mockImplementationOnce(() => firstRun.promise)
    .mockImplementationOnce(() => secondRun.promise);

  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: parent,
      sourceDirectoryPath: '/docs',
      entries: [firstEntry],
      targetParent: nestedTargetParent,
      targetDirectoryPath: 'D:\\projects\\2026',
    }),
  ).resolves.toEqual({ status: 'started' });
  await expect(
    service.pasteEntries(1, {
      mode: 'copy',
      sourceParent: parent,
      sourceDirectoryPath: '/docs',
      entries: [secondEntry],
      targetParent: nestedTargetParent,
      targetDirectoryPath: 'D:\\projects\\2026',
    }),
  ).resolves.toEqual({ status: 'started' });

  await vi.waitFor(() => {
    const tasks = service.getSnapshot().tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.status === 'running')).toBe(true);
  });

  expect(
    await service.enqueueRename({
      parent: rootDirRef,
      entry: {
        ref: ancestorDirRef,
        name: 'projects',
        kind: 'directory',
        capabilities: { rename: { support: 'supported' } },
      },
      name: 'projects-renamed',
      directoryPath: 'D:\\',
    }),
  ).toBe(false);

  firstRun.resolve({
    status: 'completed',
    entry: {
      ...committedTargetEntry,
      ref: { ...nestedTargetParent, locator: 'projects/2026/alpha.txt' },
      name: 'alpha.txt',
    },
    sourceSnapshot: { ref: firstEntry.ref, parent, name: firstEntry.name, kind: 'file', size: 10 },
  });
  secondRun.resolve({
    status: 'completed',
    entry: {
      ...committedTargetEntry,
      ref: { ...nestedTargetParent, locator: 'projects/2026/beta.txt' },
      name: 'beta.txt',
    },
    sourceSnapshot: {
      ref: secondEntry.ref,
      parent,
      name: secondEntry.name,
      kind: 'file',
      size: 10,
    },
  });
  await vi.waitFor(() =>
    expect(service.getSnapshot().tasks.every((task) => task.status === 'completed')).toBe(true),
  );

  expect(
    await service.enqueueRename({
      parent: rootDirRef,
      entry: {
        ref: ancestorDirRef,
        name: 'projects',
        kind: 'directory',
        capabilities: { rename: { support: 'supported' } },
      },
      name: 'projects-renamed',
      directoryPath: 'D:\\',
    }),
  ).toBe(true);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[2]?.status).toBe('completed'));
  await service.dispose();
});
