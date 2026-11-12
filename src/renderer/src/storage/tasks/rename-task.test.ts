import { waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskQueue } from '../../tasks/task-queue';
import { DirectoryCache } from '../directory/directory-cache';
import { StorageBrowserError } from '../storage-client';
import { createRenameTaskHandler } from './rename-task';
import type { RenameTaskInput, StorageTaskDefinitions } from './storage-task-types';

afterEach(() => vi.unstubAllGlobals());

const parent = { connectionId: 'local', spaceId: 'disk', locator: '.' };
const input: RenameTaskInput = {
  parent,
  entry: {
    ref: { ...parent, locator: 'old.txt' },
    name: 'old.txt',
    kind: 'file',
    capabilities: {},
  },
  name: 'new.txt',
  directoryPath: 'Disk',
};

it('maps rename validation errors and refreshes authorization only for authorization failures', async () => {
  const onAuthRequired = vi.fn();
  const handler = createRenameTaskHandler({ directoryCache: new DirectoryCache(), onAuthRequired });
  expect(handler.toFailure(new StorageBrowserError('InvalidArgument'))).toEqual({
    code: 'InvalidArgument',
    message: { key: 'storage:invalidEntryName' },
  });
  const failure = handler.toFailure(new StorageBrowserError('AuthRequired'));
  expect(failure.message.key).toBe('errors:AuthRequired');
  await handler.onFailure?.(input, failure);
  await handler.onFailure?.(input, handler.toFailure(new Error('private provider error')));
  expect(onAuthRequired).toHaveBeenCalledOnce();
});

it('invalidates the affected connection if applying a successful rename result fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = { ...input.entry, name: input.name };
  const renameEntry = vi.fn().mockResolvedValue({ ok: true, value: result });
  vi.stubGlobal('desktop', { storage: { renameEntry } });
  const directoryCache = new DirectoryCache();
  directoryCache.save(parent, new Map([[input.entry.ref.locator, input.entry]]));
  directoryCache.subscribeRenames(() => {
    throw new Error('private listener error');
  });
  const queue = new TaskQueue<StorageTaskDefinitions>({
    rename: createRenameTaskHandler({ directoryCache, onAuthRequired: vi.fn() }),
  });
  queue.enqueue({ type: 'rename', input });
  await waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
  expect(renameEntry).toHaveBeenCalledExactlyOnceWith(input.entry.ref, input.name);
  expect(directoryCache.version(parent.connectionId)).toBe(1);
  expect(directoryCache.peek(parent)).toBeUndefined();
  expect(log).toHaveBeenCalledOnce();
  expect(queue.store.getState().tasks[0]).toMatchObject({ result });
});
