import { expect, it, vi } from 'vitest';
import { StorageError } from '@main/storage';
import type { TaskContext } from '@main/tasks/types';
import type { Entry, EntryRef } from '@shared/storage';
import type { TransferService } from '../transfers/transfer-service';
import type { CommittedTransferFile } from '../transfers/transfer-types';
import { createCrossSourceTransferConfig, createTransferHandler } from './transfer-handler';

function createContext() {
  const controller = new AbortController();
  const reportProgress = vi.fn();
  const reportControls = vi.fn();
  const context: TaskContext = {
    taskId: 1,
    signal: controller.signal,
    reportProgress,
    reportControls,
  };
  return { context, reportProgress, reportControls };
}

it('returns skipped when canExecute is false without calling run', async () => {
  const run = vi.fn();
  const onSettled = vi.fn();
  const handler = createTransferHandler(
    'transfer',
    {
      conflictKeys: () => ['k1'],
      canExecute: () => false,
      run,
      pause: vi.fn(),
      cancel: vi.fn(),
      release: vi.fn(),
      onSettled,
      connectionId: () => 'conn-1',
    },
    { emitAuthRequired: vi.fn() },
  );

  const { context } = createContext();
  const result = await handler.execute({ id: 1 }, context);
  expect(result).toEqual({ status: 'skipped' });
  expect(run).not.toHaveBeenCalled();
  expect(onSettled).not.toHaveBeenCalled();
});

it('maps determinate/indeterminate progress, paused status, cancelled error, and AuthRequired failure', async () => {
  const emitAuthRequired = vi.fn();
  const onSettled = vi.fn();
  const { context, reportProgress } = createContext();

  const pausedHandler = createTransferHandler<{ id: number }, void>(
    'transfer',
    {
      conflictKeys: () => ['k1'],
      run: async (_input, { onProgress }) => {
        onProgress({
          controls: { cancellable: true, pausable: true },
          stageKey: 'storage:transferring',
          completedBytes: 4,
          totalBytes: 0,
        });
        onProgress({
          controls: { cancellable: true, pausable: false },
          stageKey: 'storage:transferFinalizing',
          completedBytes: 5,
          totalBytes: 10,
          bytesPerSecond: 20,
        });
        return {
          status: 'paused',
          completedBytes: 5,
          totalBytes: 10,
          error: new StorageError('NetworkError'),
        };
      },
      pause: vi.fn(),
      cancel: vi.fn(),
      release: vi.fn(),
      onSettled,
      connectionId: () => 'conn-1',
    },
    { emitAuthRequired },
  );

  const paused = await pausedHandler.execute({ id: 1 }, context);
  expect(paused).toEqual({
    status: 'paused',
    failure: { code: 'NetworkError', message: { key: 'errors:networkError' } },
  });
  expect(reportProgress).toHaveBeenNthCalledWith(1, {
    kind: 'indeterminate',
    stage: { key: 'storage:transferring' },
    completedBytes: 4,
  });
  expect(reportProgress).toHaveBeenNthCalledWith(2, {
    kind: 'determinate',
    completed: 5,
    total: 10,
    unit: 'bytes',
    stage: { key: 'storage:transferFinalizing' },
    bytesPerSecond: 20,
  });
  expect(reportProgress).toHaveBeenNthCalledWith(3, {
    kind: 'determinate',
    completed: 5,
    total: 10,
    unit: 'bytes',
  });
  expect(onSettled).toHaveBeenCalledTimes(1);

  const cancelledHandler = createTransferHandler<{ id: number }, void>(
    'transfer',
    {
      conflictKeys: () => [],
      run: async () => {
        throw new StorageError('Cancelled');
      },
      pause: vi.fn(),
      cancel: vi.fn(),
      release: vi.fn(),
      connectionId: () => 'conn-1',
    },
    { emitAuthRequired },
  );
  expect(await cancelledHandler.execute({ id: 2 }, createContext().context)).toEqual({
    status: 'cancelled',
  });

  await cancelledHandler.onFailure?.(
    { id: 2 },
    { code: 'AuthRequired', message: { key: 'errors:authRequired' } },
  );
  expect(emitAuthRequired).toHaveBeenCalledWith('conn-1');
});

it('fails move with SourceCleanupFailed when source deletion fails and retries only source deletion', async () => {
  const sourceParent: EntryRef = { connectionId: 'cloud-a', spaceId: 'drive', locator: 'src' };
  const targetParent: EntryRef = { connectionId: 'cloud-b', spaceId: 'drive', locator: 'dst' };
  const sourceEntry: Entry = {
    ref: { ...sourceParent, locator: 'file-1' },
    name: 'doc.txt',
    kind: 'file',
    size: 5,
    revision: 'rev-1',
    capabilities: { read: { support: 'supported' }, remove: { support: 'supported' } },
  };
  const committedTarget: Entry = {
    ref: { ...targetParent, locator: 'file-copy-1' },
    name: 'doc.txt',
    kind: 'file',
    size: 5,
    capabilities: {},
  };

  let committed: CommittedTransferFile | undefined;
  const runWork = vi.fn(async () => {
    committed = {
      itemId: 0,
      targetEntry: committedTarget,
      targetParent,
      sourceSnapshot: {
        ref: sourceEntry.ref,
        parent: sourceParent,
        name: sourceEntry.name,
        kind: 'file',
        size: 5,
        revision: 'rev-1',
      },
      sourceDeleted: false,
    };
    return {
      status: 'completed' as const,
      entry: committedTarget,
      sourceSnapshot: committed.sourceSnapshot,
    };
  });
  const transfers = {
    getCommittedFile: vi.fn(() => committed),
    runWork,
    markSourceDeleted: vi.fn(() => {
      if (committed) committed.sourceDeleted = true;
    }),
    pauseWork: vi.fn(),
    cancelWork: vi.fn(async () => undefined),
    canRetryWork: vi.fn(() => true),
    releaseWork: vi.fn(async () => undefined),
  } as unknown as TransferService;

  const emitDirectoryChanged = vi.fn();
  const deleteVerifiedSource = vi
    .fn()
    .mockRejectedValueOnce(new StorageError('PreconditionFailed'))
    .mockResolvedValueOnce(undefined);
  const handler = createTransferHandler(
    'transfer',
    createCrossSourceTransferConfig(transfers, { emitDirectoryChanged, deleteVerifiedSource }),
    { emitAuthRequired: vi.fn() },
  );
  const input = {
    display: {
      mode: 'move' as const,
      sourceProvider: 'google-drive' as const,
      targetProvider: 'google-drive' as const,
      sourceParent,
      targetParent,
      entry: sourceEntry,
      targetName: 'doc.txt',
      sourceDirectoryPath: '/src',
      targetDirectoryPath: '/dst',
    },
    workRef: { planId: 'plan-1', itemId: 0 },
  };

  await expect(handler.execute(input, createContext().context)).rejects.toSatisfy((error) => {
    expect(handler.toFailure(error)).toEqual({
      code: 'SourceCleanupFailed',
      message: { key: 'storage:copiedSourceNotRemoved' },
    });
    return true;
  });
  expect(runWork).toHaveBeenCalledTimes(1);
  expect(deleteVerifiedSource).toHaveBeenCalledWith(
    sourceEntry.ref,
    { expectedRevision: 'rev-1', expectedSize: 5 },
    expect.any(AbortSignal),
  );
  expect(emitDirectoryChanged).toHaveBeenCalledWith({
    kind: 'added',
    parent: targetParent,
    entry: committedTarget,
  });

  // Retry must skip re-transferring the file and only retry source deletion.
  const retryResult = await handler.execute(input, createContext().context);
  expect(retryResult).toEqual({ status: 'completed', result: committedTarget });
  expect(runWork).toHaveBeenCalledTimes(1);
  expect(deleteVerifiedSource).toHaveBeenCalledTimes(2);
  expect(emitDirectoryChanged).toHaveBeenCalledWith({
    kind: 'removed',
    parent: sourceParent,
    ref: sourceEntry.ref,
  });
});
