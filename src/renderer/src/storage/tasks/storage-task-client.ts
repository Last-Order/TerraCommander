import { createStore } from 'zustand/vanilla';
import type { TasksApi } from '../../../../shared/tasks';
import type { TaskQueueViewClient, TaskQueueViewSnapshot } from '../../tasks/task-types';
import type { DirectoryCache } from '../directory/directory-cache';
import { resultOf, StorageBrowserError } from '../storage-client';
import type {
  DeleteTaskRequest,
  PrepareDownloadRequest,
  PrepareDownloadResponse,
  RenameTaskRequest,
  StorageDirectoryChange,
  StorageTaskEvent,
  StorageTaskGroupItem,
  StorageTaskItem,
} from './storage-task-types';

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
  private readonly onAuthRequired: () => void;

  constructor(options: { directoryCache: DirectoryCache; onAuthRequired: () => void }) {
    this.directoryCache = options.directoryCache;
    this.onAuthRequired = options.onAuthRequired;
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
        if (!settled && !liveSnapshotSeen) this.store.setState(snapshot);
      })
      .catch(ignoreCommandFailure);
    return () => {
      settled = true;
      unsubscribe();
    };
  }

  enqueueRename(request: RenameTaskRequest): Promise<boolean> {
    const api = this.api;
    return api ? resultOf(api.enqueueRename(request)) : Promise.resolve(false);
  }

  enqueueDelete(request: DeleteTaskRequest): Promise<boolean> {
    const api = this.api;
    return api ? resultOf(api.enqueueDelete(request)) : Promise.resolve(false);
  }

  prepareDownload(request: PrepareDownloadRequest): Promise<PrepareDownloadResponse> {
    const api = this.api;
    if (!api) return Promise.reject(new StorageBrowserError('Unsupported'));
    return resultOf(api.prepareDownload(request));
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
    return window.desktop?.tasks;
  }

  private handleEvent(event: StorageTaskEvent): void {
    switch (event.type) {
      case 'snapshot':
        this.store.setState(event.snapshot);
        return;
      case 'directory-changed':
        this.applyDirectoryChange(event.change);
        return;
      case 'auth-required':
        this.onAuthRequired();
    }
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
      case 'invalidate-connection':
        try {
          this.directoryCache.invalidateConnection(change.connectionId);
        } catch {
          console.error('Download directory refresh failed.');
        }
    }
  }
}
