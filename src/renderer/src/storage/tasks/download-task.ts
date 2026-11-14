import { TaskCancelledError, type TaskHandler } from '../../tasks/task-types';
import { directoryKey, type DirectoryCache } from '../directory/directory-cache';
import { errorKey, resultOf } from '../storage-client';
import type { DownloadTaskInput } from './storage-task-types';

export function createDownloadTaskHandler({
  directoryCache,
  onAuthRequired,
}: {
  directoryCache: DirectoryCache;
  onAuthRequired: () => void;
}): TaskHandler<DownloadTaskInput, void> {
  return {
    category: 'transfer',
    conflictKeys: ({ entry }) => [directoryKey(entry.ref)],
    async execute({ destination }, context) {
      const unsubscribe = window.desktop.downloads.onProgress((progress) => {
        if (progress.id !== destination.id) return;
        const stage = {
          key: progress.stage === 'saving' ? 'storage:downloadSaving' : 'storage:downloadReceiving',
        } as const;
        const cancellable = progress.stage !== 'saving';
        const rate =
          progress.bytesPerSecond !== undefined ? { bytesPerSecond: progress.bytesPerSecond } : {};
        context.reportProgress(
          progress.totalBytes !== undefined && progress.totalBytes > 0
            ? {
                kind: 'determinate',
                completed: progress.completedBytes,
                total: progress.totalBytes,
                unit: 'bytes',
                stage,
                cancellable,
                ...rate,
              }
            : {
                kind: 'indeterminate',
                stage,
                cancellable,
                completedBytes: progress.completedBytes,
                ...rate,
              },
        );
      });
      try {
        await resultOf(window.desktop.downloads.run(destination.id));
      } catch (error) {
        if (errorKey(error) === 'Cancelled') throw new TaskCancelledError();
        throw error;
      } finally {
        unsubscribe();
      }
    },
    cancel: ({ destination }) => resultOf(window.desktop.downloads.cancel(destination.id)),
    onSuccess: () => directoryCache.invalidateConnection('local'),
    toFailure: (error) => {
      const code = errorKey(error);
      return { code, message: { key: `errors:${code}` } };
    },
    onFailure: (_input, failure) => {
      if (failure.code === 'AuthRequired') onAuthRequired();
    },
  };
}
