import { waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Entry } from '../../../shared/storage';
import { StorageBrowserError } from '../storage/storage-client';
import { pausePage } from '../testing/storage-browser-fixtures';
import { TaskQueue, type TaskRequest } from './task-queue';

function request(locator: string): TaskRequest {
  const parent = { connectionId: 'local', spaceId: 'disk', locator: '.' };
  return {
    type: 'rename',
    parent,
    entry: { ref: { ...parent, locator }, name: locator, kind: 'file', capabilities: {} },
    name: 'new-' + locator,
    directoryPath: 'Disk',
  };
}

it('records failures, continues the queue and only clears finished tasks', async () => {
  const first = request('first.txt');
  const second = request('second.txt');
  const pending = pausePage<Entry>();
  const execute = vi
    .fn<(task: TaskRequest) => Promise<Entry>>()
    .mockRejectedValueOnce(new StorageBrowserError('AuthRequired'))
    .mockReturnValueOnce(pending.promise);
  const onRenamed = vi.fn();
  const onAuthRequired = vi.fn();
  const queue = new TaskQueue({ execute, onRenamed, onAuthRequired });
  queue.enqueue(first);
  queue.enqueue(second);
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  expect(queue.store.getState().tasks).toMatchObject([
    { status: 'failed', error: 'AuthRequired' },
    { status: 'running' },
  ]);
  expect(onAuthRequired).toHaveBeenCalledOnce();
  expect(onRenamed).not.toHaveBeenCalled();
  queue.clearFinished();
  expect(queue.store.getState().tasks).toMatchObject([{ request: second, status: 'running' }]);
  pending.resolve({ ...second.entry, name: second.name });
  await waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
  queue.clearFinished();
  expect(queue.store.getState().tasks).toEqual([]);
});

it('rejects additional writes to running and queued entries until they finish', async () => {
  const first = request('first.txt');
  const second = request('second.txt');
  const pending = pausePage<Entry>();
  const execute = vi
    .fn(async (task: TaskRequest) => ({ ...task.entry, name: task.name }))
    .mockReturnValueOnce(pending.promise);
  const onRenamed = vi.fn();
  const queue = new TaskQueue({ execute, onRenamed, onAuthRequired: vi.fn() });
  expect(queue.enqueue(first)).toBe(true);
  expect(queue.enqueue(second)).toBe(true);
  expect(queue.enqueue({ ...first, name: 'conflicting-write.txt' })).toBe(false);
  expect(queue.enqueue({ ...second, name: 'conflicting-queued-write.txt' })).toBe(false);
  queue.clearFinished();
  expect(queue.store.getState().tasks).toHaveLength(2);
  expect(execute).toHaveBeenCalledExactlyOnceWith(first);
  const firstResult = { ...first.entry, name: first.name };
  pending.resolve(firstResult);
  await waitFor(() =>
    expect(queue.store.getState().tasks.every(({ status }) => status === 'completed')).toBe(true),
  );
  expect(onRenamed.mock.calls).toEqual([
    [first, firstResult],
    [second, { ...second.entry, name: second.name }],
  ]);
  expect(queue.enqueue({ ...first, name: 'allowed-after-completion.txt' })).toBe(true);
  await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(3));
});
