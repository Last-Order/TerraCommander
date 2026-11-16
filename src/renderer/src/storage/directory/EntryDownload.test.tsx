import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { DownloadProgress, DownloadsApi } from '../../../../shared/downloads';
import type { Entry, Space } from '../../../../shared/storage';
import { renderWorkspace } from '../../testing/render-app';
import { pausePage, success } from '../../testing/storage-browser-fixtures';

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const user = userEvent.setup();
  const space: Space = {
    id: 'my-drive',
    connectionId: 'account',
    name: '云盘',
    root: { connectionId: 'account', spaceId: 'my-drive', locator: 'root' },
  };
  const entry: Entry = {
    ref: { ...space.root, locator: 'file' },
    name: '笔记.txt',
    kind: 'file',
    capabilities: { read: { support: 'supported' } },
  };
  const pending = pausePage<Awaited<ReturnType<DownloadsApi['run']>>>();
  let listener: ((progress: DownloadProgress) => void) | undefined;
  const unsubscribe = vi.fn();
  const downloads = {
    getSettings: vi.fn(async () =>
      success({
        directory: 'D:\\Downloads',
      }),
    ),
    chooseDirectory: vi.fn<DownloadsApi['chooseDirectory']>(async () => success(null)),
    prepare: vi.fn<DownloadsApi['prepare']>(async (request) =>
      success({ id: 'download', path: `${request.directory}\\${request.expectedName}` }),
    ),
    run: vi.fn<DownloadsApi['run']>(() => pending.promise),
    pause: vi.fn<DownloadsApi['pause']>(async () => {
      pending.resolve(success({ status: 'paused', completedBytes: 4, totalBytes: 10 }));
      return success(undefined);
    }),
    cancel: vi.fn(async () => {
      pending.resolve({ ok: false, code: 'Cancelled' });
      return success(undefined);
    }),
    onProgress: vi.fn((next: (progress: DownloadProgress) => void) => {
      listener = next;
      return unsubscribe;
    }),
  };
  vi.stubGlobal('desktop', {
    downloads,
    storage: {
      listConnections: async () =>
        success([
          {
            id: 'account',
            provider: 'google-drive',
            name: '工作',
            spaces: [space],
            needsAuthorization: false,
          },
        ]),
      listDirectory: async () => success({ entries: [entry] }),
    },
  });
  await renderWorkspace();
  await user.click(await screen.findByRole('button', { name: '云盘' }));
  await user.pointer({
    target: await screen.findByRole('button', { name: entry.name }),
    keys: '[MouseRight]',
  });
  await user.click(await screen.findByRole('menuitem', { name: '下载…' }));
  const dialog = await screen.findByRole('dialog', { name: '下载…' });
  const modal = within(dialog);
  await waitFor(() =>
    expect(modal.getByRole('textbox', { name: '保存目录' })).toHaveValue('D:\\Downloads'),
  );
  return {
    user,
    entry,
    modal,
    dialog,
    downloads,
    pending,
    unsubscribe,
    report: (
      progress: Omit<DownloadProgress, 'attempt' | 'controls'> &
        Partial<Pick<DownloadProgress, 'attempt' | 'controls'>>,
    ) =>
      act(() =>
        listener?.({
          ...progress,
          attempt: progress.attempt ?? downloads.run.mock.lastCall?.[1] ?? '',
          controls: progress.controls ?? {
            cancellable: progress.stage === 'downloading',
            pausable: progress.stage === 'downloading',
          },
        }),
      ),
  };
}

it('opens an editable overlay and starts a background download without opening the directory picker', async () => {
  const { user, entry, modal, downloads, pending, unsubscribe, report } = await setup();
  expect(downloads.chooseDirectory).not.toHaveBeenCalled();
  const directory = modal.getByRole('textbox', { name: '保存目录' });
  await user.clear(directory);
  await user.type(directory, 'E:\\Saved');
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(downloads.run).toHaveBeenCalledWith('download', expect.any(String)));
  expect(downloads.prepare).toHaveBeenCalledExactlyOnceWith({
    ref: entry.ref,
    directory: 'E:\\Saved',
    expectedName: entry.name,
    replace: false,
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  report({ id: 'different', stage: 'downloading', completedBytes: 9, totalBytes: 10 });
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  report({ id: 'download', stage: 'downloading', completedBytes: 1536, bytesPerSecond: 2048 });
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('value');
  expect(screen.getByText('1.5 KiB')).toBeInTheDocument();
  expect(screen.getByLabelText('当前速率')).toHaveTextContent('2 KiB/s');
  report({
    id: 'download',
    stage: 'downloading',
    completedBytes: 4,
    totalBytes: 10,
    bytesPerSecond: 1024 ** 2,
  });
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '4');
  expect(screen.getByLabelText('当前速率')).toHaveTextContent('1 MiB/s');
  report({ id: 'download', stage: 'saving', completedBytes: 10, totalBytes: 10 });
  expect(screen.queryByLabelText('当前速率')).not.toBeInTheDocument();
  const queue = within(screen.getByRole('region', { name: '任务队列' }));
  expect(queue.getByRole('button', { name: '取消' })).toBeDisabled();
  await act(async () => {
    pending.resolve(success({ status: 'completed' }));
  });
  expect(await queue.findByLabelText('已完成')).toBeInTheDocument();
  expect(queue.getByRole('button', { name: '暂停' })).toBeDisabled();
  expect(queue.getByRole('button', { name: '取消' })).toBeDisabled();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('requires explicit replacement confirmation while retaining the download dialog underneath', async () => {
  const { user, modal, dialog, downloads, pending } = await setup();
  downloads.prepare.mockResolvedValueOnce({ ok: false, code: 'AlreadyExists' });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const confirmation = within(await screen.findByRole('dialog', { name: '确认覆盖' }));
  expect(confirmation.getByText('已存在同名文件，是否覆盖？')).toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  expect(modal.getByRole('button', { name: '开始下载' })).toBeDisabled();
  expect(modal.getByRole('textbox', { name: '保存目录' })).toBeDisabled();
  expect(downloads.run).not.toHaveBeenCalled();
  expect(downloads.prepare).toHaveBeenCalledOnce();
  await user.click(confirmation.getByRole('button', { name: '覆盖并下载' }));
  expect(downloads.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
  await act(async () => {
    pending.resolve(success({ status: 'completed' }));
  });
});

it('cancels a running transfer and unsubscribes from progress', async () => {
  const { user, modal, downloads, unsubscribe } = await setup();
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const queue = within(await screen.findByRole('region', { name: '任务队列' }));
  await user.click(await queue.findByRole('button', { name: '取消' }));
  expect(downloads.cancel).toHaveBeenCalledWith('download');
  expect(await queue.findByLabelText('已取消')).toBeInTheDocument();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(queue.getByRole('button', { name: '暂停' })).toBeDisabled();
  expect(queue.getByRole('button', { name: '取消' })).toBeDisabled();
  expect(downloads.prepare).toHaveBeenCalledOnce();
});

it('only pauses active content transfer and resumes the same task while ignoring old attempt progress', async () => {
  const { user, modal, downloads, pending, report, unsubscribe } = await setup();
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(downloads.run).toHaveBeenCalledOnce());
  const queue = within(screen.getByRole('region', { name: '任务队列' }));
  const pauseButton = queue.getByRole('button', { name: '暂停' });
  const cancelButton = queue.getByRole('button', { name: '取消' });
  expect(pauseButton).toBeDisabled();
  report({ id: 'download', stage: 'downloading', completedBytes: 4, totalBytes: 10 });
  const oldAttempt = downloads.run.mock.lastCall?.[1];
  expect(pauseButton).toBeEnabled();
  const pausing = pausePage<Awaited<ReturnType<DownloadsApi['pause']>>>();
  downloads.pause.mockReturnValueOnce(pausing.promise);
  await user.click(pauseButton);
  expect(downloads.pause).toHaveBeenCalledExactlyOnceWith('download');
  expect(queue.getByLabelText('正在暂停…')).toBeInTheDocument();
  expect(queue.getByRole('button', { name: '暂停' })).toBe(pauseButton);
  expect(pauseButton).toBeDisabled();
  expect(queue.getByRole('button', { name: '取消' })).toBe(cancelButton);
  expect(cancelButton).toBeDisabled();
  await act(async () => {
    pending.resolve(success({ status: 'paused', completedBytes: 4, totalBytes: 10 }));
    pausing.resolve(success(undefined));
  });
  expect(await queue.findByLabelText('已暂停')).toBeInTheDocument();
  expect(queue.getByRole('button', { name: '继续' })).toBe(pauseButton);
  expect(pauseButton).toBeEnabled();
  expect(cancelButton).toBeEnabled();
  expect(queue.getByRole('progressbar')).toHaveAttribute('value', '4');
  expect(screen.getByRole('contentinfo', { name: '状态栏' })).toHaveTextContent('1 项已暂停');
  expect(queue.getByRole('button', { name: '清除已结束任务' })).toBeDisabled();
  expect(unsubscribe).toHaveBeenCalledOnce();

  const resumed = pausePage<Awaited<ReturnType<DownloadsApi['run']>>>();
  downloads.run.mockReturnValueOnce(resumed.promise);
  await user.click(queue.getByRole('button', { name: '继续' }));
  await waitFor(() => expect(downloads.run).toHaveBeenCalledTimes(2));
  expect(downloads.run.mock.lastCall?.[0]).toBe('download');
  expect(downloads.run.mock.lastCall?.[1]).not.toBe(oldAttempt);
  expect(downloads.prepare).toHaveBeenCalledOnce();
  expect(queue.getByRole('button', { name: '暂停' })).toBe(pauseButton);
  expect(pauseButton).toBeDisabled();
  expect(queue.getByRole('button', { name: '取消' })).toBe(cancelButton);
  report({
    id: 'download',
    attempt: oldAttempt!,
    stage: 'downloading',
    completedBytes: 1,
    totalBytes: 10,
  });
  expect(queue.getByRole('progressbar')).toHaveAttribute('value', '4');
  report({ id: 'download', stage: 'downloading', completedBytes: 8, totalBytes: 10 });
  expect(queue.getByRole('progressbar')).toHaveAttribute('value', '8');
  expect(pauseButton).toBeEnabled();
  report({ id: 'download', stage: 'saving', completedBytes: 10, totalBytes: 10 });
  expect(pauseButton).toBeDisabled();
  expect(cancelButton).toBeDisabled();
  await act(async () => {
    resumed.resolve(success({ status: 'completed' }));
  });
  expect(await queue.findByLabelText('已完成')).toBeInTheDocument();
  expect(queue.getByRole('button', { name: '暂停' })).toBe(pauseButton);
  expect(queue.getByRole('button', { name: '取消' })).toBe(cancelButton);
  expect(pauseButton).toBeDisabled();
  expect(cancelButton).toBeDisabled();
  expect(queue.getAllByRole('listitem')).toHaveLength(1);
});

it('only dismisses the top confirmation when Escape is pressed', async () => {
  const { user, modal, downloads } = await setup();
  downloads.prepare.mockResolvedValueOnce({ ok: false, code: 'AlreadyExists' });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  await screen.findByRole('dialog', { name: '确认覆盖' });
  await user.keyboard('{Escape}');
  const restored = within(await screen.findByRole('dialog', { name: '下载…' }));
  expect(restored.getByRole('textbox', { name: '保存目录' })).toHaveValue('D:\\Downloads');
  expect(restored.getByRole('textbox', { name: '保存目录' })).toBeEnabled();
  expect(screen.queryByRole('dialog', { name: '确认覆盖' })).not.toBeInTheDocument();
  expect(downloads.run).not.toHaveBeenCalled();
});

it('returns to directory editing without authorizing an overwrite', async () => {
  const { user, modal, downloads, pending } = await setup();
  downloads.prepare.mockResolvedValueOnce({ ok: false, code: 'AlreadyExists' });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const confirmation = within(await screen.findByRole('dialog', { name: '确认覆盖' }));
  await user.click(confirmation.getByRole('button', { name: '取消' }));
  const restored = within(await screen.findByRole('dialog', { name: '下载…' }));
  const directory = restored.getByRole('textbox', { name: '保存目录' });
  expect(directory).toHaveValue('D:\\Downloads');
  expect(downloads.run).not.toHaveBeenCalled();
  await user.clear(directory);
  await user.type(directory, 'E:\\Other');
  await user.click(restored.getByRole('button', { name: '开始下载' }));
  expect(downloads.prepare).toHaveBeenLastCalledWith(
    expect.objectContaining({ directory: 'E:\\Other', replace: false }),
  );
  await act(async () => {
    pending.resolve(success({ status: 'completed' }));
  });
});
