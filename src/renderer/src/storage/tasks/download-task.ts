import type { TaskHandler } from '../../tasks/task-types';
import type { DownloadExecution } from '../../../../shared/downloads';
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
  const executions = new Map<string, DownloadExecution>();
  const key = (input: DownloadTaskInput) => JSON.stringify(input.destination.ref);
  return {
    category: 'transfer',
    conflictKeys: ({ entry }) => [directoryKey(entry.ref)],
    async execute(input, context) {
      if (input.entry.kind !== 'file' || input.entry.capabilities.read?.support === 'unsupported')
        return { status: 'skipped' };
      let paused = false;
      let unsubscribe: (() => void) | undefined;
      try {
        const destination =
          executions.get(key(input)) ??
          (await resultOf(window.desktop.downloads.resolveWork(input.destination.ref)));
        executions.set(key(input), destination);
        if (context.signal.aborted) {
          await resultOf(window.desktop.downloads.cancelWork(input.destination.ref));
          return { status: 'cancelled' };
        }
        const attempt = crypto.randomUUID();
        unsubscribe = window.desktop.downloads.onProgress((progress) => {
          if (progress.id !== destination.id || progress.attempt !== attempt) return;
          const stage = {
            key:
              progress.stage === 'saving' ? 'storage:downloadSaving' : 'storage:downloadReceiving',
          } as const;
          context.reportControls(progress.controls);
          const rate =
            progress.bytesPerSecond !== undefined
              ? { bytesPerSecond: progress.bytesPerSecond }
              : {};
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
        const result = await resultOf(window.desktop.downloads.run(destination.id, attempt));
        if (result.status === 'paused') {
          paused = true;
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
        unsubscribe?.();
        if (!paused) executions.delete(key(input));
        try {
          directoryCache.invalidateConnection('local');
        } catch {
          console.error('Download directory refresh failed.');
        }
      }
    },
    cancel: async (input) => {
      try {
        await resultOf(window.desktop.downloads.cancelWork(input.destination.ref));
      } finally {
        executions.delete(key(input));
      }
    },
    pause: async (input) => {
      const destination = executions.get(key(input));
      if (destination) await resultOf(window.desktop.downloads.pause(destination.id));
    },
    retry: async () => {},
    release: ({ destination }) => resultOf(window.desktop.downloads.releaseWork(destination.ref)),
    toFailure: (error) => {
      const code = errorKey(error);
      return { code, message: { key: `errors:${code}` } };
    },
    onFailure: (_input, failure) => {
      if (failure.code === 'AuthRequired') onAuthRequired();
    },
  };
}
