import { expect, it, vi } from 'vitest';
import { pausePage } from '../testing/storage-browser-fixtures';
import { TaskQueue } from './task-queue';
import type { TaskHandler } from './task-types';

type Definitions = { download: { input: string; result: void } };

it('keeps queued cancellation reserved until cleanup finishes and never starts the canceled task', async () => {
  const blocked = pausePage<void>();
  const cleanup = pausePage<void>();
  const execute = vi.fn<TaskHandler<string, void>['execute']>(async () => {
    await blocked.promise;
    return { status: 'completed', result: undefined };
  });
  const queue = new TaskQueue<Definitions>({
    download: {
      category: 'transfer',
      conflictKeys: (input) => [input],
      execute,
      cancel: async () => cleanup.promise,
      toFailure: () => ({ code: 'unknown', message: { key: 'tasks:unknownError' } }),
    },
  });
  for (let index = 0; index < 9; index++) queue.enqueue({ type: 'download', input: String(index) });
  expect(execute).toHaveBeenCalledTimes(8);
  const cancel = queue.cancel(9);
  expect(queue.enqueue({ type: 'download', input: '8' })).toBe(false);
  blocked.resolve();
  await vi.waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
  expect(execute).toHaveBeenCalledTimes(8);
  cleanup.resolve();
  await cancel;
  expect(queue.store.getState().tasks[8]?.status).toBe('cancelled');
  expect(queue.enqueue({ type: 'download', input: '8' })).toBe(true);
});

it('waits for running execution to settle and preserves a completed publication over a late cancel', async () => {
  const execution = pausePage<void>();
  const handler: TaskHandler<string, void> = {
    category: 'transfer',
    conflictKeys: (input) => [input],
    execute: async () => {
      await execution.promise;
      return { status: 'completed', result: undefined };
    },
    cancel: async () => {},
    toFailure: () => ({ code: 'unknown', message: { key: 'tasks:unknownError' } }),
  };
  const queue = new TaskQueue<Definitions>({ download: handler });
  queue.enqueue({ type: 'download', input: 'file' });
  await queue.cancel(1);
  expect(queue.store.getState().tasks[0]?.status).toBe('running');
  expect(queue.enqueue({ type: 'download', input: 'file' })).toBe(false);
  execution.resolve();
  await vi.waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
});

it('records cancellation separately from failure after the handler releases resources', async () => {
  const execution = pausePage<void>();
  const onSuccess = vi.fn();
  const onFailure = vi.fn();
  const toFailure = vi.fn(() => ({
    code: 'unknown',
    message: { key: 'tasks:unknownError' as const },
  }));
  const queue = new TaskQueue<Definitions>({
    download: {
      category: 'transfer',
      conflictKeys: (input) => [input],
      execute: async () => {
        await execution.promise;
        return { status: 'cancelled' };
      },
      cancel: () => {
        execution.resolve();
      },
      toFailure,
      onSuccess,
      onFailure,
    },
  });
  queue.enqueue({ type: 'download', input: 'file' });
  await queue.cancel(1);
  await vi.waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('cancelled'));
  expect(toFailure).not.toHaveBeenCalled();
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled();
});
