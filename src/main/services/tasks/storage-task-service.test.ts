import { expect, it, vi } from 'vitest';
import type { Entry } from '../../../shared/storage';
import { localConnectionId } from '../../../shared/storage-browser';
import type { StorageTaskEvent } from '../../../shared/tasks';
import { StorageError } from '../../storage';
import { deferred } from '../../testing/deferred';
import { DownloadError } from '../downloads/download-paths';
import type { DownloadProgress, DownloadRunResult } from '../downloads/download-types';
import type { DownloadService } from '../downloads/download-service';
import type { StorageBrowser } from '../storage/storage-browser';
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
    resolveWork: vi.fn(async () => ({
      id: 'exec-1',
      path: 'D:\\Downloads\\report.txt',
    })),
    cancelWork: vi.fn(async () => undefined),
    releaseWork: vi.fn(async () => undefined),
    cancelBatchItem: vi.fn(async () => undefined),
    finishBatch: vi.fn(),
    releaseBatch: vi.fn(async () => undefined),
    run: vi.fn<DownloadService['run']>(async () => ({ status: 'completed' })),
    pause: vi.fn(async () => undefined),
  };
  const renameEntry = vi.fn(async () => ({ ...fileEntry, name: 'final.txt' }));
  const deleteEntry = vi.fn(async () => undefined);
  const browser = {
    renameEntry,
    deleteEntry,
    downloads,
  } as unknown as StorageBrowser;
  const service = new StorageTaskService(browser);
  const events: StorageTaskEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, browser, downloads, renameEntry, deleteEntry, events };
}

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
  service.enqueueDelete({ parent, entry: fileEntry, directoryPath: '/docs' });
  await vi.waitFor(() => expect(service.getSnapshot().tasks[2]?.status).toBe('failed'));
  expect(events).toContainEqual({ type: 'auth-required', connectionId });

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
    const group = service.getSnapshot().groups[0];
    expect(group?.sealed).toBe(true);
    expect(group?.preparation.issues).toHaveLength(1);
    expect(group?.preparation.issues[0]?.failure.code).toBe('PermissionDenied');
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
