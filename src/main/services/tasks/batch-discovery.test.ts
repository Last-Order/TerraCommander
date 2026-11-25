import { expect, it, vi } from 'vitest';
import { StorageError } from '@main/storage';
import type { TaskGroupPreparationContext } from '@main/tasks/types';
import { prepareBatchGroup } from './batch-discovery';

interface TestItem {
  id: number;
  kind: 'file' | 'directory';
  label: string;
  skip?: boolean;
}

type TestDefinitions = {
  item: { input: { label: string }; result: void };
};

function createPrepContext() {
  const controller = new AbortController();
  const enqueued: string[] = [];
  const reportIssue = vi.fn();
  const context: TaskGroupPreparationContext<TestDefinitions> = {
    groupId: 1,
    signal: controller.signal,
    enqueue: vi.fn(async (request) => {
      enqueued.push(request.input.label);
      return true;
    }),
    reportIssue,
  };
  return { controller, enqueued, context, reportIssue };
}

it('performs DFS discovery across paginated directories, respects skipped items, and reports non-fatal issues', async () => {
  const { enqueued, context, reportIssue } = createPrepContext();
  const afterDirectory = vi.fn();

  const discoverDirectory = vi
    .fn()
    .mockResolvedValueOnce({
      items: [
        { id: 10, kind: 'file', label: 'dir/a.txt' },
        { id: 11, kind: 'directory', label: 'dir/sub' },
      ],
      nextOffset: 2,
    })
    .mockResolvedValueOnce({
      items: [{ id: 12, kind: 'file', label: 'dir/b.txt', skip: true }],
    })
    .mockRejectedValueOnce(new StorageError('PermissionDenied'));

  await prepareBatchGroup<TestItem, TestDefinitions>(
    {
      initialItems: [
        { id: 1, kind: 'directory', label: 'dir' },
        { id: 2, kind: 'file', label: 'root.txt' },
      ],
      getItemId: (item) => item.id,
      getItemLabel: (item) => item.label,
      isDirectory: (item) => item.kind === 'directory',
      discoverDirectory,
      cancelDirectoryItem: vi.fn(async () => undefined),
      cancelErrorMessage: 'cancel failed',
      fatalErrorCodes: new Set(['AuthRequired']),
      enqueueFile: async (item, prepContext) => {
        if (item.skip) return false;
        await prepContext.enqueue({ type: 'item', input: { label: item.label } }, String(item.id));
        return true;
      },
      afterDirectory,
    },
    context,
  );

  expect(enqueued).toEqual(['dir/a.txt', 'root.txt']);
  expect(reportIssue).toHaveBeenCalledWith({
    label: 'dir/sub',
    failure: { code: 'PermissionDenied', message: { key: 'errors:permissionDenied' } },
  });
  expect(afterDirectory).toHaveBeenCalledTimes(2);
});

it('cancels the active directory on abort and rethrows fatal errors', async () => {
  const { controller, context } = createPrepContext();
  const cancelDirectoryItem = vi.fn(async () => undefined);

  await expect(
    prepareBatchGroup<TestItem, TestDefinitions>(
      {
        initialItems: [{ id: 1, kind: 'directory', label: 'dir' }],
        getItemId: (item) => item.id,
        getItemLabel: (item) => item.label,
        isDirectory: (item) => item.kind === 'directory',
        discoverDirectory: async () => {
          controller.abort();
          throw new StorageError('Cancelled');
        },
        cancelDirectoryItem,
        cancelErrorMessage: 'cancel failed',
        fatalErrorCodes: new Set(['AuthRequired']),
        enqueueFile: async () => true,
      },
      context,
    ),
  ).rejects.toMatchObject({ code: 'Cancelled' });

  expect(cancelDirectoryItem).toHaveBeenCalledWith(1);
});
