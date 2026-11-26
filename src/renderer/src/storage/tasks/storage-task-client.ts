import { createStore } from 'zustand/vanilla';
import type { TaskQueueViewClient, TaskQueueViewSnapshot } from '@renderer/tasks/task-types';
import type {
  CreateDirectoryTaskRequest,
  DeleteEntriesRequest,
  PasteEntriesRequest,
  PasteEntriesResponse,
  PrepareDownloadRequest,
  PrepareDownloadResponse,
  RenameTaskRequest,
  StorageDirectoryChange,
  StorageTaskEvent,
  StorageTaskGroupItem,
  StorageTaskItem,
  StorageTaskSnapshot,
  TaskProgress,
  TasksApi,
  UploadFileRequest,
  UploadPathsRequest,
} from '@shared/tasks';
import type { DirectoryCache } from '../directory/state/directory-cache';
import type { DirectoryEffectsStore } from '../directory/state/directory-effects';
import { resultOf, StorageBrowserError } from '../storage-client';

function ignoreCommandFailure(): void {
  // Task failures and state changes flow back through snapshot events.
}

/** Renderer view store and command bridge backed by the main-process task queue. */
export class StorageTaskClient implements TaskQueueViewClient<
  StorageTaskItem,
  StorageTaskGroupItem
> {
  readonly store = createStore<TaskQueueViewSnapshot<StorageTaskItem, StorageTaskGroupItem>>()(
    () => ({
      tasks: [],
      groups: [],
    }),
  );

  private readonly directoryCache: DirectoryCache;
  private readonly directoryEffects: DirectoryEffectsStore;
  private readonly onAuthRequired: () => void;
  private readonly tasksApi?: TasksApi | undefined;

  constructor(options: {
    directoryCache: DirectoryCache;
    directoryEffects: DirectoryEffectsStore;
    onAuthRequired: () => void;
    api?: TasksApi | undefined;
  }) {
    this.directoryCache = options.directoryCache;
    this.directoryEffects = options.directoryEffects;
    this.onAuthRequired = options.onAuthRequired;
    this.tasksApi = options.api;
  }

  connect(): () => void {
    const api = this.api;
    if (!api) return () => {};
    let settled = false;
    let liveSnapshotSeen = false;
    const unsubscribe = api.onEvent((event) => {
      if (settled) return;
      if (event.type === 'snapshot') liveSnapshotSeen = true;
      this.handleEvent(event);
    });
    void resultOf(api.getSnapshot())
      .then((snapshot) => {
        if (!settled && !liveSnapshotSeen) this.applySnapshot(snapshot);
      })
      .catch(ignoreCommandFailure);
    return () => {
      settled = true;
      unsubscribe();
    };
  }

  enqueueCreateDirectory(request: CreateDirectoryTaskRequest): Promise<boolean> {
    const api = this.api;
    return api ? resultOf(api.enqueueCreateDirectory(request)) : Promise.resolve(false);
  }

  enqueueRename(request: RenameTaskRequest): Promise<boolean> {
    const api = this.api;
    return api ? resultOf(api.enqueueRename(request)) : Promise.resolve(false);
  }

  enqueueDelete(request: DeleteEntriesRequest): Promise<boolean> {
    const api = this.api;
    return api ? resultOf(api.enqueueDelete(request)) : Promise.resolve(false);
  }

  uploadFile(request: UploadFileRequest): Promise<void> {
    const api = this.api;
    if (!api) return Promise.reject(new StorageBrowserError('Unsupported'));
    return resultOf(api.uploadFile(request));
  }

  uploadFolder(request: UploadFileRequest): Promise<void> {
    const api = this.api;
    if (!api) return Promise.reject(new StorageBrowserError('Unsupported'));
    return resultOf(api.uploadFolder(request));
  }

  getPathForFile(file: File): string {
    return this.api?.getPathForFile(file) ?? '';
  }

  uploadPaths(request: UploadPathsRequest): Promise<void> {
    const api = this.api;
    if (!api) return Promise.reject(new StorageBrowserError('Unsupported'));
    return resultOf(api.uploadPaths(request));
  }

  prepareDownload(request: PrepareDownloadRequest): Promise<PrepareDownloadResponse> {
    const api = this.api;
    if (!api) return Promise.reject(new StorageBrowserError('Unsupported'));
    return resultOf(api.prepareDownload(request));
  }

  pasteEntries(request: PasteEntriesRequest): Promise<PasteEntriesResponse> {
    const api = this.api;
    if (!api) return Promise.reject(new StorageBrowserError('Unsupported'));
    return resultOf(api.pasteEntries(request));
  }

  confirmDownload(confirmationId: string): Promise<void> {
    const api = this.api;
    return api ? resultOf(api.confirmDownload(confirmationId)) : Promise.resolve();
  }

  cancelDownloadConfirmation(confirmationId: string): Promise<void> {
    const api = this.api;
    return api ? resultOf(api.cancelDownloadConfirmation(confirmationId)) : Promise.resolve();
  }

  pause(taskId: number): Promise<void> {
    const api = this.api;
    return api ? resultOf(api.pause(taskId)).catch(ignoreCommandFailure) : Promise.resolve();
  }

  resume(taskId: number): Promise<void> {
    const api = this.api;
    return api ? resultOf(api.resume(taskId)).catch(ignoreCommandFailure) : Promise.resolve();
  }

  cancel(taskId: number): Promise<void> {
    const api = this.api;
    return api ? resultOf(api.cancel(taskId)).catch(ignoreCommandFailure) : Promise.resolve();
  }

  retry(taskId: number): Promise<void> {
    const api = this.api;
    return api ? resultOf(api.retry(taskId)).catch(ignoreCommandFailure) : Promise.resolve();
  }

  clearFinished(): Promise<void> {
    const api = this.api;
    return api ? resultOf(api.clearFinished()).catch(ignoreCommandFailure) : Promise.resolve();
  }

  private get api(): TasksApi | undefined {
    return this.tasksApi ?? window.desktop?.tasks;
  }

  private handleEvent(event: StorageTaskEvent): void {
    switch (event.type) {
      case 'snapshot':
        this.applySnapshot(event.snapshot);
        return;
      case 'task-progress':
        this.applyTaskProgress(event.taskId, event.progress);
        return;
      case 'directory-changed':
        this.applyDirectoryChange(event.change);
        return;
      case 'auth-required':
        this.onAuthRequired();
    }
  }

  private applySnapshot(snapshot: StorageTaskSnapshot): void {
    this.store.setState({ tasks: snapshot.tasks, groups: snapshot.groups });
    this.directoryEffects.apply(snapshot.directoryEffects);
  }

  private applyTaskProgress(taskId: number, progress: TaskProgress): void {
    this.store.setState((state) => {
      const index = state.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) return state;
      const tasks = [...state.tasks];
      tasks[index] = { ...tasks[index]!, progress };
      return { tasks };
    });
  }

  private applyDirectoryChange(change: StorageDirectoryChange): void {
    switch (change.kind) {
      case 'renamed':
        try {
          this.directoryCache.rename(change);
        } catch {
          console.error('Could not apply the rename result; invalidating the directory cache.');
          this.directoryCache.invalidateConnection(change.parent.connectionId);
        }
        return;
      case 'removed':
        try {
          this.directoryCache.remove(change);
        } catch {
          console.error('Could not apply the deletion result; invalidating the directory cache.');
          this.directoryCache.invalidateConnection(change.parent.connectionId);
        }
        return;
      case 'added':
        try {
          this.directoryCache.add(change);
        } catch {
          console.error('Could not apply the upload result; invalidating the directory cache.');
          this.directoryCache.invalidateConnection(change.parent.connectionId);
        }
        return;
      case 'invalidate-connection':
        try {
          this.directoryCache.invalidateConnection(change.connectionId);
        } catch {
          console.error('Download directory refresh failed.');
        }
    }
  }
}
