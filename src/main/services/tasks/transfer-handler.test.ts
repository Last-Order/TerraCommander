import { expect, it, vi } from 'vitest';
import { StorageError } from '@main/storage';
import type { TaskContext } from '@main/tasks/types';
import { createTransferHandler } from './transfer-handler';

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
          stageKey: 'storage:uploadSending',
          completedBytes: 4,
          totalBytes: 0,
        });
        onProgress({
          controls: { cancellable: true, pausable: false },
          stageKey: 'storage:downloadSaving',
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
    stage: { key: 'storage:uploadSending' },
    completedBytes: 4,
  });
  expect(reportProgress).toHaveBeenNthCalledWith(2, {
    kind: 'determinate',
    completed: 5,
    total: 10,
    unit: 'bytes',
    stage: { key: 'storage:downloadSaving' },
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
