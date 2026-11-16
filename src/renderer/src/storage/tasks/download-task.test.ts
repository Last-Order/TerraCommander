import { afterEach, expect, it, vi } from 'vitest';
import type { DownloadProgress, DownloadsApi } from '../../../../shared/downloads';
import { TaskQueue } from '../../tasks/task-queue';
import { pausePage, success } from '../../testing/storage-browser-fixtures';
import { DirectoryCache } from '../directory/directory-cache';
import { createDownloadTaskHandler } from './download-task';
import type { DownloadTaskInput, StorageTaskDefinitions } from './storage-task-types';

afterEach(() => vi.unstubAllGlobals());

it.each(['pause', 'cancel'] as const)(
  'keeps a cleanup failure visible after a %s request',
  async (command) => {
    const pending = pausePage<Awaited<ReturnType<DownloadsApi['run']>>>();
    const unsubscribe = vi.fn();
    let listener: ((progress: DownloadProgress) => void) | undefined;
    const run = vi.fn<DownloadsApi['run']>(() => pending.promise);
    const stop = vi.fn(async () => {
      pending.resolve({ ok: false, code: 'DownloadCleanupFailed' });
      return success(undefined);
    });
    vi.stubGlobal('desktop', {
      downloads: {
        run,
        pause: stop,
        cancel: stop,
        onProgress: (next: (progress: DownloadProgress) => void) => {
          listener = next;
          return unsubscribe;
        },
      },
    });
    const input: DownloadTaskInput = {
      parent: { connectionId: 'account', spaceId: 'drive', locator: 'root' },
      entry: {
        ref: { connectionId: 'account', spaceId: 'drive', locator: 'file' },
        name: 'file.txt',
        kind: 'file',
        capabilities: {},
      },
      directoryPath: 'Drive',
      destination: { id: 'download', path: 'D:\\Downloads\\file.txt' },
    };
    const handler = createDownloadTaskHandler({
      directoryCache: new DirectoryCache(),
      onAuthRequired: vi.fn(),
    });
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    handler.onSuccess = onSuccess;
    handler.onFailure = onFailure;
    const queue = new TaskQueue<Pick<StorageTaskDefinitions, 'download'>>({ download: handler });
    queue.enqueue({ type: 'download', input });
    const attempt = run.mock.lastCall?.[1];
    if (!attempt) throw new Error('Missing download attempt');
    listener?.({
      id: input.destination.id,
      attempt,
      controls: { cancellable: false, pausable: false },
      stage: 'downloading',
      completedBytes: 4,
      totalBytes: 10,
    });
    const task = queue.store.getState().tasks[0];
    if (!task) throw new Error('Missing task');
    expect(queue.canCancel(task)).toBe(false);
    expect(queue.canPause(task)).toBe(false);
    listener?.({
      id: input.destination.id,
      attempt,
      controls: { cancellable: true, pausable: true },
      stage: 'downloading',
      completedBytes: 4,
      totalBytes: 10,
    });
    await queue[command](1);
    await vi.waitFor(() =>
      expect(queue.store.getState().tasks[0]).toMatchObject({
        status: 'failed',
        failure: { code: 'DownloadCleanupFailed' },
      }),
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(input, {
      code: 'DownloadCleanupFailed',
      message: { key: 'errors:DownloadCleanupFailed' },
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  },
);
