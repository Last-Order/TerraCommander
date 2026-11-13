import { waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Entry } from '../../../shared/storage';
import type { RenameTaskInput, StorageTaskDefinitions } from '../storage/tasks/storage-task-types';
import { pausePage } from '../testing/storage-browser-fixtures';
import { TaskQueue } from './task-queue';
import type { TaskHandler, TaskRequest } from './task-types';

type RenameTaskDefinitions = Pick<StorageTaskDefinitions, 'rename'>;

function request(locator: string): TaskRequest<RenameTaskDefinitions> {
  const parent = { connectionId: 'local', spaceId: 'disk', locator: '.' };
  return {
    type: 'rename',
    input: {
      parent,
      entry: { ref: { ...parent, locator }, name: locator, kind: 'file', capabilities: {} },
      name: 'new-' + locator,
      directoryPath: 'Disk',
    },
  };
}

function setup(overrides: Partial<TaskHandler<RenameTaskInput, Entry>> = {}) {
  const execute = vi.fn<TaskHandler<RenameTaskInput, Entry>['execute']>(async (input) => ({
    ...input.entry,
    name: input.name,
  }));
  const onSuccess = vi.fn();
  const onFailure = vi.fn();
  const handler: TaskHandler<RenameTaskInput, Entry> = {
    conflictKeys: (input) => [JSON.stringify(input.entry.ref)],
    execute,
    onSuccess,
    onFailure,
    toFailure: () => ({ code: 'failed', message: { key: 'tasks:unknownError' } }),
    ...overrides,
  };
  return {
    queue: new TaskQueue<RenameTaskDefinitions>({ rename: handler }),
    execute,
    onSuccess,
    onFailure,
  };
}

it('records failures, continues the queue and only clears finished tasks', async () => {
  const first = request('first.txt');
  const second = request('second.txt');
  const pending = pausePage<Entry>();
  const { queue, execute, onSuccess, onFailure } = setup();
  execute
    .mockRejectedValueOnce(new Error('private provider error'))
    .mockReturnValueOnce(pending.promise);
  queue.enqueue(first);
  queue.enqueue(second);
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  expect(queue.store.getState().tasks).toMatchObject([
    { status: 'failed', failure: { code: 'failed', message: { key: 'tasks:unknownError' } } },
    { status: 'running' },
  ]);
  expect(onFailure).toHaveBeenCalledOnce();
  expect(onSuccess).not.toHaveBeenCalled();
  queue.clearFinished();
  expect(queue.store.getState().tasks).toMatchObject([{ request: second, status: 'running' }]);
  pending.resolve({ ...second.input.entry, name: second.input.name });
  await waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
  queue.clearFinished();
  expect(queue.store.getState().tasks).toEqual([]);
});

it('rejects additional writes to running and queued entries until they finish', async () => {
  const first = request('first.txt');
  const second = request('second.txt');
  const pending = pausePage<Entry>();
  const { queue, execute, onSuccess } = setup();
  execute.mockReturnValueOnce(pending.promise);
  expect(queue.enqueue(first)).toBe(true);
  expect(queue.enqueue(second)).toBe(true);
  expect(
    queue.enqueue({ ...first, input: { ...first.input, name: 'conflicting-write.txt' } }),
  ).toBe(false);
  expect(
    queue.enqueue({ ...second, input: { ...second.input, name: 'conflicting-queued-write.txt' } }),
  ).toBe(false);
  queue.clearFinished();
  expect(queue.store.getState().tasks).toHaveLength(2);
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    first.input,
    expect.objectContaining({ reportProgress: expect.any(Function) }),
  );
  const firstResult = { ...first.input.entry, name: first.input.name };
  pending.resolve(firstResult);
  await waitFor(() =>
    expect(queue.store.getState().tasks.every(({ status }) => status === 'completed')).toBe(true),
  );
  expect(onSuccess.mock.calls).toEqual([
    [first.input, firstResult],
    [second.input, { ...second.input.entry, name: second.input.name }],
  ]);
  expect(
    queue.enqueue({ ...first, input: { ...first.input, name: 'allowed-after-completion.txt' } }),
  ).toBe(true);
  await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(3));
});

it('keeps successful operations completed when a result callback rejects and continues executing', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const onSuccess = vi.fn().mockRejectedValueOnce(new Error('private callback error'));
  const { queue, execute } = setup({ onSuccess });
  queue.enqueue(request('first.txt'));
  queue.enqueue(request('second.txt'));
  await waitFor(() =>
    expect(queue.store.getState().tasks.every(({ status }) => status === 'completed')).toBe(true),
  );
  expect(execute).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledExactlyOnceWith('Task result callback failed.', { taskId: 1 });
  expect(queue.enqueue(request('first.txt'))).toBe(true);
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
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
  await waitFor(() =>
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
  const pending = pausePage<Entry>();
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
  pending.resolve(first.input.entry);
  await waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
  const finished = queue.store.getState();
  context?.reportProgress({ kind: 'indeterminate' });
  expect(queue.store.getState()).toBe(finished);
  queue.clearFinished();
  context?.reportProgress({ kind: 'indeterminate' });
  expect(queue.store.getState().tasks).toEqual([]);
});
