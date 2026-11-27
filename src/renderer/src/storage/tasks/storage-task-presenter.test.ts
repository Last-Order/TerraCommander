import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/storage';
import type { StorageProvider } from '@shared/storage-browser';
import type { StorageTaskGroupItem, StorageTaskItem } from '@shared/tasks';
import { presentStorageTask, presentStorageTaskGroup } from './storage-task-presenter';

const controls = {
  supportsPause: true,
  supportsCancel: true,
  canPause: true,
  canResume: false,
  canCancel: true,
  canRetry: false,
};

const sampleEntry: Entry = {
  ref: { connectionId: 'src', spaceId: 's', locator: 'file-1' },
  name: 'report.txt',
  kind: 'file',
  capabilities: {},
};

function makeTransferTask(
  mode: 'copy' | 'move',
  sourceProvider: StorageProvider,
  targetProvider: StorageProvider,
  stageKey?: 'storage:transferring' | 'storage:transferFinalizing',
): StorageTaskItem {
  return {
    id: 1,
    status: 'running',
    controls,
    request: {
      type: 'transfer',
      input: {
        mode,
        sourceProvider,
        targetProvider,
        sourceParent: { connectionId: 'src', spaceId: 's', locator: '.' },
        targetParent: { connectionId: 'dst', spaceId: 'd', locator: '.' },
        entry: sampleEntry,
        targetName: 'report.txt',
        sourceDirectoryPath: '/src',
        targetDirectoryPath: '/dst',
      },
    },
    ...(stageKey
      ? {
          progress: {
            kind: 'determinate' as const,
            completed: 5,
            total: 10,
            unit: 'bytes' as const,
            stage: { key: stageKey },
          },
        }
      : {}),
  };
}

function makeTransferGroup(
  mode: 'copy' | 'move',
  sourceProvider: StorageProvider,
  targetProvider: StorageProvider,
): StorageTaskGroupItem {
  return {
    id: 2,
    sealed: true,
    state: { phase: 'active' },
    summary: {
      total: 2,
      queued: 1,
      running: 1,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    },
    preparation: { status: 'completed', issues: [] },
    request: {
      kind: 'transfer',
      input: {
        mode,
        sourceProvider,
        targetProvider,
        names: ['a.txt', 'b.txt'],
        sourcePath: '/src',
        destinationPath: '/dst',
        sourceEntries: [sampleEntry.ref],
        targetParent: { connectionId: 'dst', spaceId: 'd', locator: '.' },
      },
    },
  };
}

describe('presentStorageTask & presentStorageTaskGroup', () => {
  it('projects copy transfer directions into upload, download, and copy labels and stages', () => {
    const upload = presentStorageTask(
      makeTransferTask('copy', 'local', 'google-drive', 'storage:transferring'),
    );
    expect(upload.typeLabel).toEqual({ key: 'storage:uploadTask' });
    expect(upload.stageLabel).toEqual({ key: 'storage:uploadSending' });

    const download = presentStorageTask(
      makeTransferTask('copy', 'google-drive', 'local', 'storage:transferring'),
    );
    expect(download.typeLabel).toEqual({ key: 'storage:downloadTask' });
    expect(download.stageLabel).toEqual({ key: 'storage:downloadReceiving' });

    const downloadSaving = presentStorageTask(
      makeTransferTask('copy', 'google-drive', 'local', 'storage:transferFinalizing'),
    );
    expect(downloadSaving.stageLabel).toEqual({ key: 'storage:downloadSaving' });

    const cloudToCloud = presentStorageTask(
      makeTransferTask('copy', 'google-drive', 'google-drive', 'storage:transferring'),
    );
    expect(cloudToCloud.typeLabel).toEqual({ key: 'storage:copyTask' });
    expect(cloudToCloud.stageLabel).toEqual({ key: 'storage:transferring' });
  });

  it('always displays cross-source moves as moveTask regardless of direction', () => {
    for (const [src, dst] of [
      ['local', 'google-drive'],
      ['google-drive', 'local'],
      ['google-drive', 'google-drive'],
    ] as const) {
      const task = presentStorageTask(makeTransferTask('move', src, dst, 'storage:transferring'));
      expect(task.typeLabel).toEqual({ key: 'storage:moveTask' });
      expect(task.stageLabel).toEqual({ key: 'storage:transferring' });

      const group = presentStorageTaskGroup(makeTransferGroup('move', src, dst));
      expect(group.typeLabel).toEqual({ key: 'storage:moveTask' });
    }
  });

  it('presents cross-device copy-delete tasks and cleanup-move-source tasks as moveTask', () => {
    const crossDeviceMove = presentStorageTask({
      id: 3,
      status: 'failed',
      controls,
      request: {
        type: 'copy',
        input: {
          sourceParent: { connectionId: 'local', spaceId: 'c', locator: '.' },
          entry: sampleEntry,
          targetParent: { connectionId: 'local', spaceId: 'd', locator: '.' },
          targetName: 'report.txt',
          sourceDirectoryPath: 'C:\\',
          targetDirectoryPath: 'D:\\',
          removeSourceAfterCopy: true,
        },
      },
    });
    expect(crossDeviceMove.typeLabel).toEqual({ key: 'storage:moveTask' });

    const cleanup = presentStorageTask({
      id: 4,
      status: 'failed',
      controls,
      request: {
        type: 'cleanup-move-source',
        input: {
          sourceParent: { connectionId: 'src', spaceId: 's', locator: '.' },
          sourceDirectoryPath: '/src',
          targetDirectoryPath: '/dst',
          names: ['docs', 'notes'],
          entries: [sampleEntry.ref],
        },
      },
    });
    expect(cleanup.typeLabel).toEqual({ key: 'storage:moveTask' });
    expect(cleanup.title).toEqual([{ text: 'docs' }]);
    expect(cleanup.titleNote).toEqual({ key: 'tasks:groupMoreEntries', values: { count: 1 } });
  });
});
