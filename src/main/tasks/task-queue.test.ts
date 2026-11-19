import { expect, it, vi } from 'vitest';
import { deferred } from '../testing/deferred';
import { TaskQueue } from './task-queue';
import type { TaskExecutionOutcome, TaskHandler, TaskRequest } from './types';

interface RenameInput {
  id: string;
  name: string;
}
type RenameDefinitions = { rename: { input: RenameInput; result: string } };
type Category = 'operation';

function request(id: string): TaskRequest<RenameDefinitions> {
  return {
    type: 'rename',
    input: { id, name: 'new-' + id },
  };
}

function setup(overrides: Partial<TaskHandler<RenameInput, string, Category>> = {}) {
  const execute = vi.fn<TaskHandler<RenameInput, string, Category>['execute']>(async (input) => ({
    status: 'completed',
    result: input.name,
  }));
  const onSuccess = vi.fn();
  const onFailure = vi.fn();
  const handler: TaskHandler<RenameInput, string, Category> = {
    category: 'operation',
    conflictKeys: (input) => [input.id],
    execute,
    onSuccess,
    onFailure,
    toFailure: () => ({ code: 'failed', message: { key: 'tasks:unknownError' } }),
    ...overrides,
  };
  return {
    queue: new TaskQueue<RenameDefinitions, Record<string, { input: unknown }>, Category>(
      { rename: handler },
      { concurrencyLimits: { operation: 16 } },
    ),
    execute,
    onSuccess,
    onFailure,
  };
}

it('records failures, continues the queue and only clears finished tasks', async () => {
  const first = request('first.txt');
  const second = request('second.txt');
  const pending = deferred<TaskExecutionOutcome<string>>();
  const { queue, execute, onSuccess, onFailure } = setup();
  execute
    .mockRejectedValueOnce(new Error('private provider error'))
    .mockReturnValueOnce(pending.promise);
  queue.enqueue(first);
  queue.enqueue(second);
  await vi.waitFor(() =>
    expect(queue.store.getState().tasks).toMatchObject([
      { status: 'failed', failure: { code: 'failed', message: { key: 'tasks:unknownError' } } },
      { status: 'running' },
    ]),
  );
  expect(execute).toHaveBeenCalledTimes(2);
  expect(onFailure).toHaveBeenCalledOnce();
  expect(onSuccess).not.toHaveBeenCalled();
  queue.clearFinished();
  expect(queue.store.getState().tasks).toMatchObject([{ request: second, status: 'running' }]);
  pending.resolve({ status: 'completed', result: second.input.name });
  await vi.waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
  queue.clearFinished();
  expect(queue.store.getState().tasks).toEqual([]);
});

it('rejects additional writes to running and queued entries until they finish', async () => {
  const first = request('first.txt');
  const second = request('second.txt');
  const pending = deferred<void>();
  const { queue, execute, onSuccess } = setup();
  execute.mockImplementation(async (input) => {
    await pending.promise;
    return { status: 'completed', result: input.name };
  });
  expect(queue.enqueue(first)).toBe(true);
  for (let index = 0; index < 15; index++) {
    expect(queue.enqueue(request(`other-${index}.txt`))).toBe(true);
  }
  expect(queue.enqueue(second)).toBe(true);
  expect(
    queue.enqueue({ ...first, input: { ...first.input, name: 'conflicting-write.txt' } }),
  ).toBe(false);
  expect(
    queue.enqueue({ ...second, input: { ...second.input, name: 'conflicting-queued-write.txt' } }),
  ).toBe(false);
  queue.clearFinished();
  expect(queue.store.getState().tasks).toHaveLength(17);
  expect(queue.store.getState().tasks.at(-1)?.status).toBe('queued');
  expect(execute).toHaveBeenCalledTimes(16);
  expect(execute).toHaveBeenNthCalledWith(
    1,
    first.input,
    expect.objectContaining({ reportProgress: expect.any(Function) }),
  );
  pending.resolve();
  await vi.waitFor(() =>
    expect(queue.store.getState().tasks.every(({ status }) => status === 'completed')).toBe(true),
  );
  expect(onSuccess).toHaveBeenCalledTimes(17);
  expect(onSuccess).toHaveBeenCalledWith(first.input, first.input.name);
  expect(onSuccess).toHaveBeenCalledWith(second.input, second.input.name);
  expect(
    queue.enqueue({ ...first, input: { ...first.input, name: 'allowed-after-completion.txt' } }),
  ).toBe(true);
  await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(18));
});

it('keeps successful operations completed when a result callback rejects and continues executing', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const onSuccess = vi.fn().mockRejectedValueOnce(new Error('private callback error'));
  const { queue, execute } = setup({ onSuccess });
  queue.enqueue(request('first.txt'));
  queue.enqueue(request('second.txt'));
  await vi.waitFor(() =>
    expect(queue.store.getState().tasks.every(({ status }) => status === 'completed')).toBe(true),
  );
  expect(execute).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledExactlyOnceWith('Task result callback failed.', { taskId: 1 });
  expect(queue.enqueue(request('first.txt'))).toBe(true);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
});

it('survives error mapping and failure callback errors without leaking the underlying error', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { queue, execute } = setup({
    toFailure: () => {
      throw new Error('private mapper error');
    },
    onFailure: () => {
      throw new Error('private callback error');
    },
  });
  execute.mockRejectedValueOnce(new Error('private provider error'));
  queue.enqueue(request('first.txt'));
  queue.enqueue(request('second.txt'));
  await vi.waitFor(() =>
    expect(queue.store.getState().tasks.map(({ status }) => status)).toEqual([
      'failed',
      'completed',
    ]),
  );
  expect(queue.store.getState().tasks[0]).toMatchObject({
    failure: { code: 'unknown', message: { key: 'tasks:unknownError' } },
  });
  expect(log.mock.calls).toEqual([
    ['Task error mapping failed.', { taskId: 1 }],
    ['Task result callback failed.', { taskId: 1 }],
  ]);
});

it('reports progress only while its own task is running and ignores late callbacks', async () => {
  const pending = deferred<TaskExecutionOutcome<string>>();
  const { queue, execute } = setup();
  execute.mockReturnValueOnce(pending.promise);
  const first = request('first.txt');
  queue.enqueue(first);
  const context = execute.mock.calls[0]?.[1];
  expect(context).toBeDefined();
  context?.reportProgress({ kind: 'indeterminate' });
  expect(queue.store.getState().tasks[0]).toMatchObject({ progress: { kind: 'indeterminate' } });
  context?.reportProgress({ kind: 'determinate', completed: 2, total: 4, unit: 'items' });
  expect(queue.store.getState().tasks[0]).toMatchObject({ progress: { completed: 2, total: 4 } });
  pending.resolve({ status: 'completed', result: first.input.name });
  await vi.waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
  const finished = queue.store.getState();
  context?.reportProgress({ kind: 'indeterminate' });
  context?.reportControls({ cancellable: true, pausable: true });
  expect(queue.store.getState()).toBe(finished);
  queue.clearFinished();
  context?.reportProgress({ kind: 'indeterminate' });
  context?.reportControls({ cancellable: true, pausable: true });
  expect(queue.store.getState().tasks).toEqual([]);
});

it('cancels safely if disposed while an async retry preparation is pending', async () => {
  const retryGate = deferred<void>();
  const execute = vi.fn<TaskHandler<RenameInput, string, Category>['execute']>(async () => {
    throw new Error('fail');
  });
  const { queue } = setup({
    execute,
    retry: () => retryGate.promise,
  });
  queue.enqueue(request('retry-dispose.txt'));
  await vi.waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('failed'));
  const retrying = queue.retry(1);
  expect(queue.store.getState().tasks[0]?.status).toBe('queued');
  expect(queue.store.getState().tasks[0]?.controlRequest).toBeUndefined();
  const disposing = queue.dispose();
  retryGate.resolve();
  await Promise.all([retrying, disposing]);
  expect(queue.store.getState().tasks[0]?.status).toBe('cancelled');
});
