import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Entry } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import type { StorageTaskEvent } from '@shared/tasks';
import { StorageError, type WriteExecution } from '@main/storage';
import { deferred } from '@main/testing/deferred';
import { DownloadError } from '../downloads/download-paths';
import type { DownloadProgress, DownloadRunResult } from '../downloads/download-types';
import type { DownloadService } from '../downloads/download-service';
import type { StorageBrowser } from '../storage/storage-browser';
import { UploadService } from '../uploads/upload-service';
import { StorageTaskService } from './storage-task-service';

const connectionId = '5e45885a-89f0-462e-9821-7195cba174e5';
const parent = { connectionId, spaceId: 'drive', locator: 'folder' };
const fileEntry: Entry = {
  ref: { connectionId, spaceId: 'drive', locator: 'file-1' },
  name: 'report.txt',
  kind: 'file',
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
  capabilities: { list: { support: 'supported' } },
};

function setup() {
  const resolveWork = vi.fn(async () => ({
    id: 'exec-1',
    path: 'D:\\Downloads\\report.txt',
  }));
  const run = vi.fn<DownloadService['run']>(async () => ({ status: 'completed' }));
  const pause = vi.fn(async () => undefined);
  const downloads = {
    prepare: vi.fn(async () => ({
      ref: { planId: 'single-plan', itemId: 0 },
      path: 'D:\\Downloads\\report.txt',
    })),
    prepareBatch: vi.fn(async () => ({
      id: 'batch-1',
      path: 'D:\\Downloads',
      conflicts: [] as string[],
      items: [
        {
          id: 1,
          path: 'docs',
          targetPath: 'D:\\Downloads\\docs',
          entry: folderEntry,
        },
      ],
    })),
    confirmBatch: vi.fn(),
    discoverBatchDirectory: vi.fn<DownloadService['discoverBatchDirectory']>(async () => ({
      items: [],
    })),
    resolveWork,
    cancelWork: vi.fn(async () => undefined),
    releaseWork: vi.fn(async () => undefined),
    cancelBatchItem: vi.fn(async () => undefined),
    finishBatch: vi.fn(),
    releaseBatch: vi.fn(async () => undefined),
    run,
    pause,
    runWork: vi.fn<DownloadService['runWork']>(async (owner, _ref, options) => {
      const execution = await resolveWork();
      const attempt = 'test-attempt';
      return run(
        owner,
        execution.id,
        (progress) => {
          if (progress.id !== execution.id) return;
          const { id: _id, attempt: _attempt, ...rest } = progress;
          options.onProgress(rest);
        },
        attempt,
      );
    }),
    pauseWork: vi.fn<DownloadService['pauseWork']>(async () => {
      await pause();
    }),
  };
  const createDirectory = vi.fn(async ({ name }: { name: string }) => ({
    ...folderEntry,
    name,
  }));
  const renameEntry = vi.fn(async () => ({ ...fileEntry, name: 'final.txt' }));
  const deleteEntry = vi.fn(async () => undefined);
  const browser = {
    createDirectory,
    renameEntry,
    deleteEntry,
    downloads,
  } as unknown as StorageBrowser;
  const service = new StorageTaskService(browser);
  const events: StorageTaskEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, browser, downloads, createDirectory, renameEntry, deleteEntry, events };
}

it('executes create-directory tasks, prevents concurrent name conflicts, and maps errors', async () => {
  const { service, createDirectory, events } = setup();
  const pending = deferred<Entry>();
  createDirectory.mockImplementationOnce(() => pending.promise);

  expect(service.enqueueCreateDirectory({ parent, name: 'Projects', directoryPath: '/docs' })).toBe(
    true,
  );
  expect(service.enqueueCreateDirectory({ parent, name: 'Projects', directoryPath: '/docs' })).toBe(
    false,
  );

  const created = { ...folderEntry, name: 'Projects' };
  pending.resolve(created);
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));
  expect(createDirectory).toHaveBeenCalledWith({ parent, name: 'Projects' });
  expect(events).toContainEqual({
    type: 'directory-changed',
    change: { kind: 'added', parent, entry: created },
  });

  createDirectory.mockRejectedValueOnce(new StorageError('InvalidArgument'));
  expect(service.enqueueCreateDirectory({ parent, name: 'bad', directoryPath: '/docs' })).toBe(
    true,
  );
  await vi.waitFor(() => expect(service.getSnapshot().tasks[1]?.status).toBe('failed'));
  expect(service.getSnapshot().tasks[1]?.failure).toEqual({
    code: 'InvalidArgument',
    message: { key: 'storage:invalidEntryName' },
  });

  createDirectory.mockRejectedValueOnce(new StorageError('AuthRequired'));
  expect(service.enqueueCreateDirectory({ parent, name: 'Auth', directoryPath: '/docs' })).toBe(
    true,
  );
  await vi.waitFor(() => expect(service.getSnapshot().tasks[2]?.status).toBe('failed'));
  expect(events).toContainEqual({ type: 'auth-required', connectionId });

  await service.dispose();
});

it('executes rename and delete tasks, projects directory changes, and maps validation errors', async () => {
  const { service, renameEntry, deleteEntry, events } = setup();

  expect(
    service.enqueueRename({ parent, entry: fileEntry, name: 'final.txt', directoryPath: '/docs' }),
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
  service.enqueueRename({ parent, entry: fileEntry, name: 'bad', directoryPath: '/docs' });
  await vi.waitFor(() => expect(service.getSnapshot().tasks[1]?.status).toBe('failed'));
  expect(service.getSnapshot().tasks[1]?.failure).toEqual({
    code: 'InvalidArgument',
    message: { key: 'storage:invalidEntryName' },
  });

  deleteEntry.mockRejectedValueOnce(new StorageError('AuthRequired'));
  service.enqueueDelete({ parent, entries: [fileEntry], directoryPath: '/docs' });
  await vi.waitFor(() => expect(service.getSnapshot().tasks[2]?.status).toBe('failed'));
  expect(events).toContainEqual({ type: 'auth-required', connectionId });

  await service.dispose();
});

it('creates a delete task group for multiple entries including folders and rejects conflicting batches', async () => {
  const { service, deleteEntry, events } = setup();
  const folderEntry: Entry = {
    ref: { connectionId, spaceId: 'drive', locator: 'folder-1' },
    name: 'Folder',
    kind: 'directory',
    capabilities: { remove: { support: 'supported' } },
  };
  let releaseFirst!: () => void;
  const firstDone = new Promise<undefined>((resolve) => {
    releaseFirst = () => resolve(undefined);
  });
  deleteEntry.mockImplementationOnce(() => firstDone);

  expect(
    service.enqueueDelete({
      parent,
      entries: [fileEntry, folderEntry],
      directoryPath: '/docs',
    }),
  ).toBe(true);
  expect(
    service.enqueueDelete({
      parent,
      entries: [folderEntry],
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
        entries: [fileEntry.ref, folderEntry.ref],
      },
    },
  });
  expect(activeSnapshot.tasks.map((task) => task.groupId)).toEqual([
    activeSnapshot.groups[0]!.id,
    activeSnapshot.groups[0]!.id,
  ]);

  releaseFirst();
  await vi.waitFor(() =>
    expect(service.getSnapshot().tasks.every((task) => task.status === 'completed')).toBe(true),
  );
  expect(deleteEntry).toHaveBeenCalledWith(fileEntry.ref);
  expect(deleteEntry).toHaveBeenCalledWith(folderEntry.ref);
  expect(events).toContainEqual({
    type: 'directory-changed',
    change: { kind: 'removed', parent, ref: fileEntry.ref },
  });
  expect(events).toContainEqual({
    type: 'directory-changed',
    change: { kind: 'removed', parent, ref: folderEntry.ref },
  });

  await service.dispose();
});

it('handles single-file download overwrite confirmation, pause/resume, retry, and strips workRef from snapshots', async () => {
  const { service, downloads, events } = setup();
  downloads.prepare.mockRejectedValueOnce(new StorageError('AlreadyExists'));

  const conflict = await service.prepareDownload(1, {
    parent,
    entries: [fileEntry],
    directory: 'D:\\Downloads',
    directoryPath: '/docs',
  });
  expect(conflict.status).toBe('conflict');
  if (conflict.status !== 'conflict') throw new Error('Expected conflict');
  expect(conflict.conflicts).toBeUndefined();

  await expect(service.confirmDownload(2, conflict.confirmationId)).rejects.toMatchObject({
    code: 'InvalidArgument',
  });

  const firstRun = deferred<DownloadRunResult>();
  const retryRun = deferred<DownloadRunResult>();
  downloads.run
    .mockImplementationOnce(
      async (_owner, _id, onProgress: (p: DownloadProgress) => void, attempt) => {
        onProgress({
          id: 'exec-1',
          attempt: attempt ?? '',
          controls: { cancellable: true, pausable: true },
          stage: 'downloading',
          completedBytes: 5,
          totalBytes: 10,
          bytesPerSecond: 20,
        });
        return firstRun.promise;
      },
    )
    .mockImplementationOnce(async () => retryRun.promise);

  await service.confirmDownload(1, conflict.confirmationId);
  expect(downloads.prepare).toHaveBeenLastCalledWith(
    0,
    expect.objectContaining({ replace: true, expectedName: fileEntry.name }),
  );

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
    change: { kind: 'invalidate-connection', connectionId: localConnectionId },
  });

  await service.dispose();
});

it('runs in-process DFS batch discovery, handles non-fatal issues, and releases only uncommitted confirmations on owner reset', async () => {
  const { service, downloads, events } = setup();
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

  const activeTransfer = deferred<DownloadRunResult>();
  downloads.run.mockImplementationOnce(() => activeTransfer.promise);
  downloads.discoverBatchDirectory
    .mockResolvedValueOnce({
      items: [
        {
          id: 2,
          path: 'docs/a.txt',
          targetPath: 'D:\\Downloads\\docs\\a.txt',
          entry: childFile,
          parent: folderEntry.ref,
        },
        {
          id: 3,
          path: 'docs/sub',
          targetPath: 'D:\\Downloads\\docs\\sub',
          entry: nestedDir,
          parent: folderEntry.ref,
        },
      ],
    })
    .mockRejectedValueOnce(new StorageError('PermissionDenied'));

  const started = await service.prepareDownload(1, {
    parent,
    entries: [folderEntry],
    directory: 'D:\\Downloads',
    directoryPath: '/docs',
  });
  expect(started).toEqual({ status: 'started' });

  await vi.waitFor(() => {
    const snapshot = service.getSnapshot();
    const group = snapshot.groups[0];
    expect(group?.sealed).toBe(true);
    expect(group?.preparation.issues).toHaveLength(1);
    expect(group?.preparation.issues[0]?.failure.code).toBe('PermissionDenied');
    expect(group?.request).toEqual({
      kind: 'download',
      input: {
        names: [folderEntry.name],
        sourcePath: '/docs',
        destinationPath: 'D:\\Downloads',
        entries: [folderEntry.ref],
      },
    });
    expect(snapshot.tasks[0]).not.toHaveProperty('memberKey');
  });

  // Uncommitted confirmation from owner 1 should be released on owner reset without touching active task.
  downloads.prepareBatch.mockResolvedValueOnce({
    id: 'batch-pending',
    path: 'D:\\Downloads',
    conflicts: ['other.txt'],
    items: [
      {
        id: 1,
        path: 'other.txt',
        targetPath: 'D:\\Downloads\\other.txt',
        entry: { ...fileEntry, ref: { ...fileEntry.ref, locator: 'other' }, name: 'other.txt' },
      },
    ],
  });
  const pendingConflict = await service.prepareDownload(1, {
    parent,
    entries: [fileEntry, folderEntry],
    directory: 'D:\\Downloads',
    directoryPath: '/docs',
  });
  expect(pendingConflict.status).toBe('conflict');

  service.cancelOwnerConfirmations(1);
  await vi.waitFor(() => expect(downloads.releaseBatch).toHaveBeenCalledWith(0, 'batch-pending'));
  expect(service.getSnapshot().tasks[0]?.status).toBe('running');

  activeTransfer.resolve({ status: 'completed' });
  await vi.waitFor(() =>
    expect(service.getSnapshot().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'partial',
    }),
  );
  expect(downloads.finishBatch).toHaveBeenCalledWith(0, 'batch-1');
  expect(events).toContainEqual({
    type: 'directory-changed',
    change: { kind: 'invalidate-connection', connectionId: localConnectionId },
  });

  service.clearFinished();
  expect(service.getSnapshot().tasks).toHaveLength(0);
  expect(service.getSnapshot().groups).toHaveLength(0);
  expect(downloads.releaseBatch).toHaveBeenCalledWith(0, 'batch-1');
});

it('rejects prepareDownload if DownloadTargetBusy occurs after enqueue conflict check and emits auth-required on fatal discovery errors', async () => {
  const { service, downloads, events } = setup();
  downloads.discoverBatchDirectory.mockRejectedValueOnce(new StorageError('AuthRequired'));

  await service.prepareDownload(1, {
    parent,
    entries: [folderEntry],
    directory: 'D:\\Downloads',
    directoryPath: '/docs',
  });
  await vi.waitFor(() =>
    expect(service.getSnapshot().groups[0]?.preparation.status).toBe('failed'),
  );
  expect(events).toContainEqual({ type: 'auth-required', connectionId });

  // Second request targeting an already-active standalone entry should release work and fail with DownloadTargetBusy.
  const blocked = deferred<DownloadRunResult>();
  downloads.run.mockImplementationOnce(() => blocked.promise);
  await service.prepareDownload(1, {
    parent,
    entries: [fileEntry],
    directory: 'D:\\Downloads',
    directoryPath: '/docs',
  });
  downloads.prepare.mockResolvedValueOnce({
    ref: { planId: 'single-plan-2', itemId: 0 },
    path: 'D:\\Downloads\\other\\report.txt',
  });
  await expect(
    service.prepareDownload(1, {
      parent,
      entries: [fileEntry],
      directory: 'D:\\OtherDownloads',
      directoryPath: '/docs',
    }),
  ).rejects.toBeInstanceOf(DownloadError);
  expect(downloads.releaseWork).toHaveBeenCalledWith(0, { planId: 'single-plan-2', itemId: 0 });

  blocked.resolve({ status: 'completed' });
  await service.dispose();
});

it('uploads mixed files and folders as a task group, emits directory changes, and retains folder IDs on retry', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-task-upload-'));
  const rootFile = join(temporary.path, 'cover.txt');
  const folder = join(temporary.path, 'docs');
  await writeFile(rootFile, 'cover');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'guide.txt'), 'guide');

  let nextId = 1;
  const createDirectory = vi.fn(
    async ({ parent: targetParent, name }: { parent: typeof parent; name: string }) => ({
      ref: { ...targetParent, locator: `created-dir-${nextId++}` },
      name,
      kind: 'directory' as const,
      capabilities: {
        write: { support: 'supported' as const },
        createDirectory: { support: 'supported' as const },
      },
    }),
  );
  const prepareUpload = vi.fn((targetParent: typeof parent, name: string): WriteExecution => {
    if (
      name === 'guide.txt' &&
      prepareUpload.mock.calls.filter((call) => call[1] === 'guide.txt').length === 1
    ) {
      throw new StorageError('OutcomeUnknown', { retryHint: 'safe' });
    }
    return {
      run: vi.fn<WriteExecution['run']>(async () => ({
        ref: { ...targetParent, locator: `uploaded-${nextId++}` },
        name,
        kind: 'file',
        capabilities: {},
      })),
    };
  });
  const uploads = new UploadService({
    stat: async (ref) => ({
      ref,
      name: 'Root',
      kind: 'directory',
      capabilities: { write: { support: 'supported' }, createDirectory: { support: 'supported' } },
    }),
    createDirectory,
    prepareUpload,
  });
  const browser = {
    uploads,
  } as unknown as StorageBrowser;
  const service = new StorageTaskService(browser);
  const events: StorageTaskEvent[] = [];
  service.subscribe((event) => events.push(event));

  try {
    await service.uploadSelectedPaths(1, {
      parent,
      directoryPath: '/Drive',
      paths: [rootFile, folder],
    });

    await vi.waitFor(() => {
      const snapshot = service.getSnapshot();
      expect(snapshot.groups[0]?.state).toEqual({ phase: 'settled', outcome: 'partial' });
    });

    const createdDocsRef = { ...parent, locator: 'created-dir-1' };
    expect(createDirectory).toHaveBeenCalledTimes(1);
    expect(prepareUpload).toHaveBeenCalledWith(parent, 'cover.txt', expect.anything());
    expect(events).toContainEqual({
      type: 'directory-changed',
      change: {
        kind: 'added',
        parent,
        entry: expect.objectContaining({ ref: createdDocsRef, name: 'docs', kind: 'directory' }),
      },
    });

    const failedTask = service
      .getSnapshot()
      .tasks.find(
        (task) => task.request.type === 'upload' && task.request.input.name === 'guide.txt',
      )!;
    expect(failedTask.status).toBe('failed');
    expect(failedTask.controls.canRetry).toBe(true);

    await service.retry(failedTask.id);
    await vi.waitFor(() => {
      const snapshot = service.getSnapshot();
      expect(snapshot.groups[0]?.state).toEqual({ phase: 'settled', outcome: 'completed' });
    });

    expect(createDirectory).toHaveBeenCalledTimes(1);
    const guideCalls = prepareUpload.mock.calls.filter((call) => call[1] === 'guide.txt');
    expect(guideCalls).toHaveLength(2);
    expect(guideCalls[1]?.[0]).toEqual(createdDocsRef);
  } finally {
    await service.dispose();
    await uploads.dispose();
  }
});

it('emits lightweight task-progress events for progress ticks and includes directoryEffects on snapshots', async () => {
  const { service, downloads, events } = setup();
  const finish = deferred<DownloadRunResult>();
  let reportProgress: ((progress: DownloadProgress) => void) | undefined;
  downloads.run.mockImplementationOnce(async (_owner, id, onProgress, attempt) => {
    reportProgress = onProgress;
    onProgress({
      id,
      attempt: attempt ?? 'test-attempt',
      stage: 'downloading',
      completedBytes: 10,
      totalBytes: 100,
      controls: { cancellable: true, pausable: true },
    });
    return finish.promise;
  });

  try {
    await service.prepareDownload(1, {
      parent,
      entries: [fileEntry],
      directory: 'D:\\Downloads',
      directoryPath: '/Drive',
    });

    await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.controls.canPause).toBe(true));
    expect(service.getSnapshot().directoryEffects).toEqual({
      busyEntries: [fileEntry.ref],
      renames: [],
    });

    const beforeTicks = events.length;
    reportProgress?.({
      id: 'exec-1',
      attempt: 'test-attempt',
      stage: 'downloading',
      completedBytes: 40,
      totalBytes: 100,
      bytesPerSecond: 2048,
      controls: { cancellable: true, pausable: true },
    });
    reportProgress?.({
      id: 'exec-1',
      attempt: 'test-attempt',
      stage: 'downloading',
      completedBytes: 80,
      totalBytes: 100,
      bytesPerSecond: 4096,
      controls: { cancellable: true, pausable: true },
    });

    const tickEvents = events.slice(beforeTicks);
    expect(tickEvents).toEqual([
      {
        type: 'task-progress',
        taskId: 1,
        progress: {
          kind: 'determinate',
          completed: 40,
          total: 100,
          unit: 'bytes',
          stage: { key: 'storage:downloadReceiving' },
          bytesPerSecond: 2048,
        },
      },
      {
        type: 'task-progress',
        taskId: 1,
        progress: {
          kind: 'determinate',
          completed: 80,
          total: 100,
          unit: 'bytes',
          stage: { key: 'storage:downloadReceiving' },
          bytesPerSecond: 4096,
        },
      },
    ]);

    finish.resolve({ status: 'completed' });
    await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe('completed'));
    expect(service.getSnapshot().directoryEffects).toEqual({
      busyEntries: [],
      renames: [],
    });
  } finally {
    await service.dispose();
  }
});
