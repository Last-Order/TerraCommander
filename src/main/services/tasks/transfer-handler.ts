import type { ResourceLocks, TaskHandler } from '@main/tasks/types';
import { entryKey, type Entry, type EntryRef, type RemoveOptions } from '@shared/storage';
import type { StorageDirectoryChange, TaskProgress, TransferTaskDisplayInput } from '@shared/tasks';
import type { TransferService } from '../transfers/transfer-service';
import type { TransferWorkRef } from '../transfers/transfer-types';
import { SourceCleanupError, toBrowserErrorCode, toTaskFailure } from './task-errors';
import { queueOwnerId } from './transfer-session-coordinator';

export interface InternalTransferInput {
  display: TransferTaskDisplayInput;
  workRef: TransferWorkRef;
}

export interface TransferProgressReport {
  controls: { cancellable: boolean; pausable: boolean };
  stageKey: 'storage:transferring' | 'storage:transferFinalizing';
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
  conflictKeys: (input: TInput) => ResourceLocks;
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
  onSuccess?: (input: TInput, result: TResult) => void | Promise<void>;
  connectionId: (input: TInput) => string;
}

export interface TransferCallbacks {
  emitAuthRequired: (connectionId: string) => void;
  emitDirectoryChanged: (change: StorageDirectoryChange) => void;
  deleteVerifiedSource: (
    ref: EntryRef,
    options: RemoveOptions,
    signal?: AbortSignal,
  ) => Promise<void>;
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

/** Builds a unified queue handler for cross-source byte transfers. */
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

export function createCrossSourceTransferConfig(
  transfers: TransferService,
  callbacks: Pick<TransferCallbacks, 'emitDirectoryChanged' | 'deleteVerifiedSource'>,
): TransferHandlerConfig<InternalTransferInput, Entry> {
  return {
    conflictKeys: ({ display }) => [entryKey(display.entry.ref)],
    canExecute: ({ display }) =>
      display.entry.kind === 'file' && display.entry.capabilities.read?.support !== 'unsupported',
    run: async ({ display, workRef }, { signal, onProgress }) => {
      let committed = transfers.getCommittedFile(queueOwnerId, workRef);
      if (!committed) {
        const result = await transfers.runWork(queueOwnerId, workRef, {
          signal,
          onProgress: (progress) => {
            onProgress({
              controls: progress.controls,
              stageKey:
                progress.stage === 'finalizing'
                  ? 'storage:transferFinalizing'
                  : 'storage:transferring',
              completedBytes: progress.completedBytes,
              totalBytes: progress.totalBytes,
              bytesPerSecond: progress.bytesPerSecond,
            });
          },
        });
        if (result.status === 'skipped') return { status: 'skipped' };
        if (result.status === 'cancelled') return { status: 'cancelled' };
        if (result.status === 'paused') {
          return {
            status: 'paused',
            completedBytes: result.completedBytes,
            totalBytes: result.totalBytes,
            error: result.error,
          };
        }
        callbacks.emitDirectoryChanged({
          kind: 'added',
          parent: display.targetParent,
          entry: result.entry,
        });
        committed = transfers.getCommittedFile(queueOwnerId, workRef) ?? {
          itemId: workRef.itemId,
          targetEntry: result.entry,
          targetParent: display.targetParent,
          sourceSnapshot: result.sourceSnapshot,
          sourceDeleted: false,
        };
      }

      if (display.mode === 'move' && !committed.sourceDeleted) {
        const snap = committed.sourceSnapshot;
        const removeOptions: RemoveOptions = {
          ...(snap.revision !== undefined ? { expectedRevision: snap.revision } : {}),
          ...(snap.checksum !== undefined ? { expectedChecksum: snap.checksum } : {}),
          ...(snap.size !== undefined ? { expectedSize: snap.size } : {}),
        };
        try {
          await callbacks.deleteVerifiedSource(snap.ref, removeOptions, signal);
        } catch (error) {
          throw new SourceCleanupError(error);
        }
        transfers.markSourceDeleted(queueOwnerId, workRef);
        callbacks.emitDirectoryChanged({
          kind: 'removed',
          parent: snap.parent,
          ref: snap.ref,
        });
      }

      return { status: 'completed', result: committed.targetEntry };
    },
    pause: ({ workRef }) => {
      transfers.pauseWork(queueOwnerId, workRef);
    },
    cancel: ({ workRef }) => transfers.cancelWork(queueOwnerId, workRef),
    canRetry: ({ workRef }) => transfers.canRetryWork(queueOwnerId, workRef),
    release: ({ workRef }) => transfers.releaseWork(queueOwnerId, workRef),
    connectionId: ({ display }) =>
      display.sourceProvider !== 'local' && display.targetProvider === 'local'
        ? display.sourceParent.connectionId
        : display.targetParent.connectionId,
  };
}
