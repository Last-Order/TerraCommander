import type { TaskHandler } from '../../tasks/task-types';
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
      const attempt = crypto.randomUUID();
      const unsubscribe = window.desktop.downloads.onProgress((progress) => {
        if (progress.id !== destination.id || progress.attempt !== attempt) return;
        const stage = {
          key: progress.stage === 'saving' ? 'storage:downloadSaving' : 'storage:downloadReceiving',
        } as const;
        context.reportControls(progress.controls);
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
                ...rate,
              }
            : {
                kind: 'indeterminate',
                stage,
                completedBytes: progress.completedBytes,
                ...rate,
              },
        );
      });
      try {
        const result = await resultOf(window.desktop.downloads.run(destination.id, attempt));
        if (result.status === 'paused') {
          context.reportProgress(
            result.totalBytes !== undefined && result.totalBytes > 0
              ? {
                  kind: 'determinate',
                  completed: result.completedBytes,
                  total: result.totalBytes,
                  unit: 'bytes',
                }
              : { kind: 'indeterminate', completedBytes: result.completedBytes },
          );
          return { status: 'paused' };
        }
        return { status: 'completed', result: undefined };
      } catch (error) {
        if (errorKey(error) === 'Cancelled') return { status: 'cancelled' };
        throw error;
      } finally {
        unsubscribe();
      }
    },
    cancel: ({ destination }) => resultOf(window.desktop.downloads.cancel(destination.id)),
    pause: ({ destination }) => resultOf(window.desktop.downloads.pause(destination.id)),
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
