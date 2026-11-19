import { expect, it, vi } from 'vitest';
import { deferred } from '../testing/deferred';
import { TaskQueue } from './task-queue';
import type { TaskHandler, TaskType } from './types';

type TestDefinitions = Record<'rename' | 'delete' | 'transfer', { input: string; result: void }>;
type Category = 'operation' | 'transfer';

function setup(overrides: Partial<TaskHandler<string, void, Category>> = {}) {
  const pending = new Map<string, ReturnType<typeof deferred<void>>>();
  const execute = vi.fn<TaskHandler<string, void, Category>['execute']>(async (input) => {
    await pending.get(input)?.promise;
    return { status: 'completed', result: undefined };
  });
  const operation: TaskHandler<string, void, Category> = {
    category: 'operation',
    conflictKeys: (input) => [input],
    execute,
    toFailure: () => ({ code: 'failed', message: { key: 'tasks:unknownError' } }),
    ...overrides,
  };
  const queue = new TaskQueue<TestDefinitions, Record<string, { input: unknown }>, Category>(
    {
      rename: operation,
      delete: operation,
      transfer: { ...operation, category: 'transfer' },
    },
    { concurrencyLimits: { operation: 16, transfer: 8 } },
  );
  const enqueue = (type: TaskType<TestDefinitions>, input: string) => {
    const completion = deferred<void>();
    pending.set(input, completion);
    expect(queue.enqueue({ type, input })).toBe(true);
    return completion;
  };
  return { queue, execute, enqueue };
}

it('runs 16 shared operation slots and 8 independent transfer slots, refilling each in order', async () => {
  const { queue, execute, enqueue } = setup();
  const operations = Array.from({ length: 16 }, (_, index) =>
    enqueue(index % 2 === 0 ? 'rename' : 'delete', `operation-${index}`),
  );
  const waitingOperation = enqueue('delete', 'operation-16');
  const transfers = Array.from({ length: 8 }, (_, index) =>
    enqueue('transfer', `transfer-${index}`),
  );
  const waitingTransfer = enqueue('transfer', 'transfer-8');
  const nextOperation = enqueue('rename', 'operation-17');
  const nextTransfer = enqueue('transfer', 'transfer-9');

  expect(execute).toHaveBeenCalledTimes(24);
  expect(
    queue.store
      .getState()
      .tasks.filter(({ status }) => status === 'queued')
      .map(({ request }) => request.input),
  ).toEqual(['operation-16', 'transfer-8', 'operation-17', 'transfer-9']);

  operations[10]?.resolve();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(25));
  expect(execute).toHaveBeenLastCalledWith('operation-16', expect.anything());

  queue.clearFinished();
  operations[8]?.resolve();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(26));
  expect(execute).toHaveBeenLastCalledWith('operation-17', expect.anything());

  transfers[3]?.resolve();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(27));
  expect(execute).toHaveBeenLastCalledWith('transfer-8', expect.anything());
  transfers[1]?.resolve();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(28));
  expect(execute).toHaveBeenLastCalledWith('transfer-9', expect.anything());

  for (const completion of [
    ...operations,
    ...transfers,
    waitingOperation,
    waitingTransfer,
    nextOperation,
    nextTransfer,
  ]) {
    completion.resolve();
  }
  await vi.waitFor(() =>
    expect(queue.store.getState().tasks.every(({ status }) => status === 'completed')).toBe(true),
  );
});

it.each([false, true])(
  'holds a slot until its result hook finishes, execution failed: %s',
  async (failed) => {
    const execution = deferred<void>();
    const callback = deferred<void>();
    const hook = vi.fn().mockReturnValueOnce(callback.promise);
    const { queue, execute, enqueue } = setup(failed ? { onFailure: hook } : { onSuccess: hook });
    execute.mockImplementationOnce(async () => {
      await execution.promise;
      if (failed) throw new Error('private provider error');
      return { status: 'completed', result: undefined };
    });
    const operations = Array.from({ length: 17 }, (_, index) =>
      enqueue('rename', `operation-${index}`),
    );
    expect(execute).toHaveBeenCalledTimes(16);

    execution.resolve();
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
    expect(queue.store.getState().tasks[0]?.status).toBe('running');
    expect(queue.store.getState().tasks.at(-1)?.status).toBe('queued');
    expect(execute).toHaveBeenCalledTimes(16);

    callback.resolve();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(17));
    expect(queue.store.getState().tasks[0]?.status).toBe(failed ? 'failed' : 'completed');
    for (const operation of operations) operation.resolve();
    await vi.waitFor(() =>
      expect(
        queue.store
          .getState()
          .tasks.every(({ status }) => status === 'completed' || status === 'failed'),
      ).toBe(true),
    );
  },
);
