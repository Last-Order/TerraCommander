import { randomUUID } from 'node:crypto';
import type { Entry } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import type {
  DownloadTaskDisplayInput,
  StorageDirectoryChange,
  TaskProgress,
  UploadTaskDisplayInput,
} from '@shared/tasks';
import type { TaskHandler } from '@main/tasks/types';
import type { DownloadExecution, DownloadWorkRef } from '../downloads/download-types';
import type { StorageBrowser } from '../storage/storage-browser';
import type { UploadWorkRef } from '../uploads/upload-types';
import { entryKey, queueOwnerId, toBrowserErrorCode, toTaskFailure, workKey } from './task-errors';

export interface InternalDownloadInput extends DownloadTaskDisplayInput {
  workRef: DownloadWorkRef;
}

export interface InternalUploadInput {
  display: UploadTaskDisplayInput;
  workRef: UploadWorkRef;
}

export interface TransferProgressReport {
  controls: { cancellable: boolean; pausable: boolean };
  stageKey: 'storage:downloadReceiving' | 'storage:downloadSaving' | 'storage:uploadSending';
  completedBytes: number;
  totalBytes?: number | undefined;
  bytesPerSecond?: number | undefined;
}

export type TransferOutcome<TResult> =
  | { status: 'completed'; result: TResult }
  | { status: 'paused'; completedBytes: number; totalBytes?: number | undefined; error?: unknown }
  | { status: 'cancelled' }
  | { status: 'skipped' };

export interface TransferHandlerConfig<TInput, TResult> {
  conflictKeys: (input: TInput) => string[];
  canExecute?: (input: TInput) => boolean;
  run: (
    input: TInput,
    options: {
      signal: AbortSignal;
      onProgress: (progress: TransferProgressReport) => void;
    },
  ) => Promise<TransferOutcome<TResult>>;
  pause: (input: TInput) => void | Promise<void>;
  cancel: (input: TInput) => Promise<void>;
  canRetry?: (input: TInput) => boolean;
  release: (input: TInput) => Promise<void>;
  onSettled?: (input: TInput) => void;
  onSuccess?: (input: TInput, result: TResult) => void;
  connectionId: (input: TInput) => string;
}

export interface TransferCallbacks {
  emitAuthRequired: (connectionId: string) => void;
  emitDirectoryChanged: (change: StorageDirectoryChange) => void;
}

function toRunningProgress(progress: TransferProgressReport): TaskProgress {
  const stage = { key: progress.stageKey } as const;
  const rate =
    progress.bytesPerSecond !== undefined ? { bytesPerSecond: progress.bytesPerSecond } : {};
  if (progress.totalBytes !== undefined && progress.totalBytes > 0) {
    return {
      kind: 'determinate',
      completed: progress.completedBytes,
      total: progress.totalBytes,
      unit: 'bytes',
      stage,
      ...rate,
    };
  }
  return {
    kind: 'indeterminate',
    stage,
    ...(progress.completedBytes > 0 ? { completedBytes: progress.completedBytes } : {}),
    ...rate,
  };
}

function toPausedProgress(completedBytes: number, totalBytes?: number): TaskProgress {
  if (totalBytes !== undefined && totalBytes > 0) {
    return {
      kind: 'determinate',
      completed: completedBytes,
      total: totalBytes,
      unit: 'bytes',
    };
  }
  return { kind: 'indeterminate', completedBytes };
}

/** Builds a unified queue handler for both download and upload transfers. */
export function createTransferHandler<TInput, TResult, TCategory extends string = 'transfer'>(
  category: TCategory,
  config: TransferHandlerConfig<TInput, TResult>,
  callbacks: Pick<TransferCallbacks, 'emitAuthRequired'>,
): TaskHandler<TInput, TResult, TCategory> {
  return {
    category,
    conflictKeys: config.conflictKeys,
    execute: async (input, context) => {
      if (config.canExecute && !config.canExecute(input)) {
        return { status: 'skipped' };
      }
      try {
        const outcome = await config.run(input, {
          signal: context.signal,
          onProgress: (progress) => {
            context.reportControls(progress.controls);
            context.reportProgress(toRunningProgress(progress));
          },
        });
        if (outcome.status === 'skipped') return { status: 'skipped' };
        if (outcome.status === 'cancelled') return { status: 'cancelled' };
        if (outcome.status === 'paused') {
          context.reportProgress(toPausedProgress(outcome.completedBytes, outcome.totalBytes));
          return {
            status: 'paused',
            ...(outcome.error !== undefined ? { failure: toTaskFailure(outcome.error) } : {}),
          };
        }
        return { status: 'completed', result: outcome.result };
      } catch (error) {
        if (toBrowserErrorCode(error) === 'Cancelled') return { status: 'cancelled' };
        throw error;
      } finally {
        config.onSettled?.(input);
      }
    },
    pause: config.pause,
    cancel: config.cancel,
    ...(config.canRetry ? { canRetry: config.canRetry } : {}),
    retry: async () => {},
    release: config.release,
    ...(config.onSuccess ? { onSuccess: config.onSuccess } : {}),
    toFailure: (error) => toTaskFailure(error),
    onFailure: (input, failure) => {
      if (failure.code === 'AuthRequired') {
        callbacks.emitAuthRequired(config.connectionId(input));
      }
    },
  };
}

export function createDownloadTransferConfig(
  downloads: StorageBrowser['downloads'],
  callbacks: Pick<TransferCallbacks, 'emitDirectoryChanged'>,
): TransferHandlerConfig<InternalDownloadInput, void> {
  const executions = new Map<string, DownloadExecution>();

  return {
    conflictKeys: ({ entry }) => [entryKey(entry.ref)],
    canExecute: ({ entry }) =>
      entry.kind === 'file' && entry.capabilities.read?.support !== 'unsupported',
    run: async (input, { signal, onProgress }) => {
      const executionKey = workKey(input.workRef);
      let paused = false;
      try {
        const execution =
          executions.get(executionKey) ??
          (await downloads.resolveWork(queueOwnerId, input.workRef));
        executions.set(executionKey, execution);
        if (signal.aborted) {
          await downloads.cancelWork(queueOwnerId, input.workRef);
          return { status: 'cancelled' };
        }
        const attempt = randomUUID();
        const result = await downloads.run(
          queueOwnerId,
          execution.id,
          (progress) => {
            if (progress.id !== execution.id || progress.attempt !== attempt) return;
            onProgress({
              controls: progress.controls,
              stageKey:
                progress.stage === 'saving'
                  ? 'storage:downloadSaving'
                  : 'storage:downloadReceiving',
              completedBytes: progress.completedBytes,
              totalBytes: progress.totalBytes,
              bytesPerSecond: progress.bytesPerSecond,
            });
          },
          attempt,
        );
        if (result.status === 'paused') {
          paused = true;
          return {
            status: 'paused',
            completedBytes: result.completedBytes,
            totalBytes: result.totalBytes,
            error: result.error,
          };
        }
        return { status: 'completed', result: undefined };
      } finally {
        if (!paused) executions.delete(executionKey);
      }
    },
    pause: async ({ workRef }) => {
      const execution = executions.get(workKey(workRef));
      if (execution) await downloads.pause(queueOwnerId, execution.id);
    },
    cancel: async ({ workRef }) => {
      try {
        await downloads.cancelWork(queueOwnerId, workRef);
      } finally {
        executions.delete(workKey(workRef));
      }
    },
    release: ({ workRef }) => downloads.releaseWork(queueOwnerId, workRef),
    onSettled: () => {
      callbacks.emitDirectoryChanged({
        kind: 'invalidate-connection',
        connectionId: localConnectionId,
      });
    },
    connectionId: ({ entry }) => entry.ref.connectionId,
  };
}

export function createUploadTransferConfig(
  uploads: StorageBrowser['uploads'],
  callbacks: Pick<TransferCallbacks, 'emitDirectoryChanged'>,
): TransferHandlerConfig<InternalUploadInput, Entry> {
  return {
    // Each creation has its own provider ID, even when the destination name is shared.
    conflictKeys: () => [],
    run: async ({ workRef }, { signal, onProgress }) => {
      const result = await uploads.runWork(queueOwnerId, workRef, {
        signal,
        onProgress: (progress) => {
          onProgress({
            controls: progress.controls,
            stageKey: 'storage:uploadSending',
            completedBytes: progress.confirmedBytes,
            totalBytes: progress.totalBytes,
            bytesPerSecond: progress.bytesPerSecond,
          });
        },
      });
      if (result.status === 'completed') return { status: 'completed', result: result.entry };
      if (result.status === 'cancelled') return { status: 'cancelled' };
      return {
        status: 'paused',
        completedBytes: result.confirmedBytes,
        totalBytes: result.totalBytes,
        error: result.error,
      };
    },
    pause: ({ workRef }) => {
      uploads.pauseWork(queueOwnerId, workRef);
    },
    cancel: ({ workRef }) => uploads.cancelWork(queueOwnerId, workRef),
    canRetry: ({ workRef }) => uploads.canRetryWork(queueOwnerId, workRef),
    release: ({ workRef }) => uploads.releaseWork(queueOwnerId, workRef),
    onSuccess: ({ display }, entry) => {
      callbacks.emitDirectoryChanged({ kind: 'added', parent: display.parent, entry });
    },
    connectionId: ({ display }) => display.parent.connectionId,
  };
}
