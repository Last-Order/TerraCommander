import { vi } from 'vitest';
import type { Entry, EntryRef } from '@shared/storage';
import type { BrowserResult } from '@shared/storage-browser';
import type {
  PrepareDownloadRequest,
  PrepareDownloadResponse,
  StorageTaskEvent,
  StorageTaskGroupItem,
  StorageTaskItem,
  StorageTaskSnapshot,
  TaskFailure,
  TasksApi,
} from '@shared/tasks';
import { success } from './storage-browser-fixtures';

interface FakeTasksOptions {
  renameEntry?: (ref: EntryRef, name: string) => Promise<BrowserResult<Entry>>;
  deleteEntry?: (ref: EntryRef) => Promise<BrowserResult<void>>;
  prepareDownload?: (
    request: PrepareDownloadRequest,
  ) => Promise<BrowserResult<PrepareDownloadResponse>>;
  confirmDownload?: (confirmationId: string) => Promise<BrowserResult<void>>;
  cancelDownloadConfirmation?: (confirmationId: string) => Promise<BrowserResult<void>>;
  pause?: (taskId: number) => Promise<BrowserResult<void>>;
  resume?: (taskId: number) => Promise<BrowserResult<void>>;
  cancel?: (taskId: number) => Promise<BrowserResult<void>>;
  retry?: (taskId: number) => Promise<BrowserResult<void>>;
  clearFinished?: () => Promise<BrowserResult<void>>;
}

function entryKey({ connectionId, spaceId, locator }: EntryRef): string {
  return JSON.stringify([connectionId, spaceId, locator]);
}

function isFinishedStatus(status: StorageTaskItem['status']): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped'
  );
}

const defaultControls = {
  supportsPause: false,
  supportsCancel: false,
  canPause: false,
  canResume: false,
  canCancel: false,
  canRetry: false,
};

function toFailure(
  code: Exclude<BrowserResult<never>, { ok: true }>['code'],
  invalidArgumentKey?: string,
): TaskFailure {
  return {
    code,
    message: {
      key: code === 'InvalidArgument' && invalidArgumentKey ? invalidArgumentKey : `errors:${code}`,
    },
  };
}

export function createFakeTasksApi(options: FakeTasksOptions = {}) {
  let nextId = 0;
  let snapshot: StorageTaskSnapshot = { tasks: [], groups: [] };
  const listeners = new Set<(event: StorageTaskEvent) => void>();

  const emit = (event: StorageTaskEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const setSnapshot = (next: StorageTaskSnapshot) => {
    snapshot = next;
    emit({ type: 'snapshot', snapshot });
  };

  const upsertTask = (task: StorageTaskItem) => {
    const exists = snapshot.tasks.some((item) => item.id === task.id);
    setSnapshot({
      ...snapshot,
      tasks: exists
        ? snapshot.tasks.map((item) => (item.id === task.id ? task : item))
        : [...snapshot.tasks, task],
    });
  };

  const upsertGroup = (group: StorageTaskGroupItem) => {
    const exists = snapshot.groups.some((item) => item.id === group.id);
    setSnapshot({
      ...snapshot,
      groups: exists
        ? snapshot.groups.map((item) => (item.id === group.id ? group : item))
        : [...snapshot.groups, group],
    });
  };

  const isBusy = (ref: EntryRef) => {
    const target = entryKey(ref);
    return snapshot.tasks.some(
      (task) => !isFinishedStatus(task.status) && entryKey(task.request.input.entry.ref) === target,
    );
  };

  const api = {
    getSnapshot: vi.fn<TasksApi['getSnapshot']>(async () => success(snapshot)),
    enqueueRename: vi.fn<TasksApi['enqueueRename']>(async (request) => {
      if (isBusy(request.entry.ref)) return success(false);
      const id = ++nextId;
      upsertTask({
        id,
        request: { type: 'rename', input: request },
        status: 'running',
        controls: { ...defaultControls },
      });
      void Promise.resolve(
        options.renameEntry
          ? options.renameEntry(request.entry.ref, request.name)
          : success({ ...request.entry, name: request.name }),
      ).then((result) => {
        if (result.ok) {
          emit({
            type: 'directory-changed',
            change: {
              kind: 'renamed',
              parent: request.parent,
              previous: request.entry.ref,
              entry: result.value,
            },
          });
          upsertTask({
            id,
            request: { type: 'rename', input: request },
            status: 'completed',
            result: result.value,
            controls: { ...defaultControls },
          });
        } else {
          if (result.code === 'AuthRequired') {
            emit({ type: 'auth-required', connectionId: request.entry.ref.connectionId });
          }
          upsertTask({
            id,
            request: { type: 'rename', input: request },
            status: 'failed',
            failure: toFailure(result.code, 'storage:invalidEntryName'),
            controls: { ...defaultControls },
          });
        }
      });
      return success(true);
    }),
    enqueueDelete: vi.fn<TasksApi['enqueueDelete']>(async (request) => {
      if (isBusy(request.entry.ref)) return success(false);
      const id = ++nextId;
      upsertTask({
        id,
        request: { type: 'delete', input: request },
        status: 'running',
        controls: { ...defaultControls },
      });
      void Promise.resolve(
        options.deleteEntry ? options.deleteEntry(request.entry.ref) : success(undefined),
      ).then((result) => {
        if (result.ok) {
          emit({
            type: 'directory-changed',
            change: { kind: 'removed', parent: request.parent, ref: request.entry.ref },
          });
          upsertTask({
            id,
            request: { type: 'delete', input: request },
            status: 'completed',
            controls: { ...defaultControls },
          });
        } else {
          if (result.code === 'AuthRequired') {
            emit({ type: 'auth-required', connectionId: request.entry.ref.connectionId });
          }
          upsertTask({
            id,
            request: { type: 'delete', input: request },
            status: 'failed',
            failure: toFailure(result.code),
            controls: { ...defaultControls },
          });
        }
      });
      return success(true);
    }),
    prepareDownload: vi.fn<TasksApi['prepareDownload']>(async (request) =>
      options.prepareDownload ? options.prepareDownload(request) : success({ status: 'started' }),
    ),
    confirmDownload: vi.fn<TasksApi['confirmDownload']>(async (confirmationId) =>
      options.confirmDownload ? options.confirmDownload(confirmationId) : success(undefined),
    ),
    cancelDownloadConfirmation: vi.fn<TasksApi['cancelDownloadConfirmation']>(
      async (confirmationId) =>
        options.cancelDownloadConfirmation
          ? options.cancelDownloadConfirmation(confirmationId)
          : success(undefined),
    ),
    pause: vi.fn<TasksApi['pause']>(async (taskId) =>
      options.pause ? options.pause(taskId) : success(undefined),
    ),
    resume: vi.fn<TasksApi['resume']>(async (taskId) =>
      options.resume ? options.resume(taskId) : success(undefined),
    ),
    cancel: vi.fn<TasksApi['cancel']>(async (taskId) =>
      options.cancel ? options.cancel(taskId) : success(undefined),
    ),
    retry: vi.fn<TasksApi['retry']>(async (taskId) =>
      options.retry ? options.retry(taskId) : success(undefined),
    ),
    clearFinished: vi.fn<TasksApi['clearFinished']>(async () => {
      if (options.clearFinished) return options.clearFinished();
      const settledGroups = new Set(
        snapshot.groups.filter((group) => group.state.phase === 'settled').map((g) => g.id),
      );
      setSnapshot({
        tasks: snapshot.tasks.filter(
          (task) =>
            !(
              isFinishedStatus(task.status) &&
              (task.groupId === undefined || settledGroups.has(task.groupId))
            ),
        ),
        groups: snapshot.groups.filter((group) => !settledGroups.has(group.id)),
      });
      return success(undefined);
    }),
    onEvent: vi.fn<TasksApi['onEvent']>((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  } satisfies TasksApi;

  return {
    api,
    emit,
    setSnapshot,
    getSnapshot: () => snapshot,
    upsertTask,
    upsertGroup,
    nextTaskId: () => ++nextId,
  };
}
