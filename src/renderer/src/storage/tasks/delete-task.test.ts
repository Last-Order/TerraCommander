import { waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskQueue } from '../../tasks/task-queue';
import { DirectoryCache } from '../directory/directory-cache';
import { StorageBrowserError } from '../storage-client';
import { createDeleteTaskHandler } from './delete-task';
import { createRenameTaskHandler } from './rename-task';
import type { DeleteTaskInput, StorageTaskDefinitions } from './storage-task-types';
import { pausePage, success } from '../../testing/storage-browser-fixtures';
import type { BrowserResult } from '../../../../shared/storage-browser';

afterEach(() => vi.unstubAllGlobals());

const parent = { connectionId: 'local', spaceId: 'disk', locator: '.' };
const input: DeleteTaskInput = {
  parent,
  entry: {
    ref: { ...parent, locator: 'notes.txt' },
    name: 'notes.txt',
    kind: 'file',
    capabilities: {},
  },
  directoryPath: 'Disk',
};

it('shares write conflicts with rename for running and queued deletions', async () => {
  const pending = pausePage<BrowserResult<void>>();
  const deleteEntry = vi.fn().mockReturnValue(pending.promise);
  const renameEntry = vi.fn().mockResolvedValue(success(input.entry));
  vi.stubGlobal('desktop', { storage: { deleteEntry, renameEntry } });
  const options = { directoryCache: new DirectoryCache(), onAuthRequired: vi.fn() };
  const queue = new TaskQueue<StorageTaskDefinitions>({
    delete: createDeleteTaskHandler(options),
    rename: createRenameTaskHandler(options),
  });
  const other = { ...input, entry: { ...input.entry, ref: { ...parent, locator: 'other.txt' } } };
  expect(queue.enqueue({ type: 'delete', input })).toBe(true);
  for (let index = 0; index < 15; index++) {
    expect(
      queue.enqueue({
        type: 'delete',
        input: {
          ...input,
          entry: { ...input.entry, ref: { ...parent, locator: `extra-${index}` } },
        },
      }),
    ).toBe(true);
  }
  expect(queue.enqueue({ type: 'delete', input: other })).toBe(true);
  expect(queue.store.getState().tasks.at(-1)?.status).toBe('queued');
  for (const target of [input, other]) {
    expect(queue.enqueue({ type: 'delete', input: target })).toBe(false);
    expect(queue.enqueue({ type: 'rename', input: { ...target, name: 'renamed.txt' } })).toBe(
      false,
    );
  }
  expect(deleteEntry).toHaveBeenCalledTimes(16);
  pending.resolve(success(undefined));
  await waitFor(() =>
    expect(queue.store.getState().tasks.every((task) => task.status === 'completed')).toBe(true),
  );
  expect(deleteEntry).toHaveBeenCalledTimes(17);
  expect(renameEntry).not.toHaveBeenCalled();
});

it('refreshes authorization only for authorization failures', async () => {
  const onAuthRequired = vi.fn();
  const handler = createDeleteTaskHandler({ directoryCache: new DirectoryCache(), onAuthRequired });
  const failure = handler.toFailure(new StorageBrowserError('AuthRequired'));
  expect(failure.message.key).toBe('errors:AuthRequired');
  await handler.onFailure?.(input, failure);
  await handler.onFailure?.(input, handler.toFailure(new StorageBrowserError('PermissionDenied')));
  expect(onAuthRequired).toHaveBeenCalledOnce();
});

it('invalidates the connection if a successful deletion cannot update its cached listing', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const directoryCache = new DirectoryCache();
  directoryCache.save(parent, new Map([[input.entry.ref.locator, input.entry]]));
  directoryCache.subscribeRemovals(() => {
    throw new Error('private listener failure');
  });
  const handler = createDeleteTaskHandler({ directoryCache, onAuthRequired: vi.fn() });
  await handler.onSuccess?.(input, undefined);
  expect(directoryCache.version(parent.connectionId)).toBe(1);
  expect(directoryCache.peek(parent)).toBeUndefined();
});
