import { describe, expect, it, vi } from 'vitest';
import type { Entry, EntryRef } from '@shared/storage';
import type { StorageTaskEvent, StorageTaskSnapshot, TasksApi } from '@shared/tasks';
import { DirectoryCache } from '../directory/directory-cache';
import { DirectoryEffectsStore } from '../directory/directory-effects';
import { StorageTaskClient } from './storage-task-client';

const parent: EntryRef = { connectionId: 'conn', spaceId: 'drive', locator: 'folder' };
const file: Entry = {
  ref: { ...parent, locator: 'file-1' },
  name: 'report.txt',
  kind: 'file',
  capabilities: {},
};

const idleControls = {
  supportsPause: true,
  supportsCancel: true,
  canPause: true,
  canResume: false,
  canCancel: true,
  canRetry: false,
};

function createSnapshot(): StorageTaskSnapshot {
  return {
    tasks: [
      {
        id: 1,
        status: 'running',
        controls: idleControls,
        request: {
          type: 'download',
          input: { parent, entry: file, directoryPath: '/', destinationPath: 'D:\\report.txt' },
        },
        progress: { kind: 'determinate', completed: 10, total: 100, unit: 'bytes' },
      },
    ],
    groups: [
      {
        id: 2,
        request: {
          kind: 'download',
          input: {
            names: ['docs'],
            sourcePath: '/',
            destinationPath: 'D:\\docs',
            entries: [file.ref],
          },
        },
        sealed: false,
        state: { phase: 'active' },
        summary: {
          total: 0,
          queued: 0,
          running: 0,
          paused: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          skipped: 0,
        },
        preparation: { status: 'running', issues: [] },
      },
    ],
    directoryEffects: {
      busyEntries: [file.ref],
      renames: [],
    },
  };
}

describe('StorageTaskClient', () => {
  it('hydrates directory effects from snapshots and patches progress without touching effects', async () => {
    let emit: ((event: StorageTaskEvent) => void) | undefined;
    const initial = createSnapshot();
    const api = {
      getSnapshot: vi.fn(async () => ({ ok: true as const, value: initial })),
      onEvent: vi.fn((listener: (event: StorageTaskEvent) => void) => {
        emit = listener;
        return () => {
          emit = undefined;
        };
      }),
    } as unknown as TasksApi;

    const directoryCache = new DirectoryCache();
    const directoryEffects = new DirectoryEffectsStore();
    const applySpy = vi.spyOn(directoryEffects, 'apply');
    const client = new StorageTaskClient({
      directoryCache,
      directoryEffects,
      onAuthRequired: vi.fn(),
      api,
    });

    const disconnect = client.connect();
    await vi.waitFor(() => expect(client.store.getState().tasks).toHaveLength(1));

    expect(directoryEffects.isBusy(file.ref)).toBe(true);
    expect(applySpy).toHaveBeenCalledTimes(1);

    emit?.({
      type: 'task-progress',
      taskId: 1,
      progress: {
        kind: 'determinate',
        completed: 50,
        total: 100,
        unit: 'bytes',
        bytesPerSecond: 1024,
      },
    });

    expect(client.store.getState().tasks[0]?.progress).toEqual({
      kind: 'determinate',
      completed: 50,
      total: 100,
      unit: 'bytes',
      bytesPerSecond: 1024,
    });
    expect(applySpy).toHaveBeenCalledTimes(1);

    disconnect();
  });
});
