import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { DownloadProgress, DownloadsApi } from '../../../../shared/downloads';
import type { Entry, Space } from '../../../../shared/storage';
import { renderWorkspace } from '../../testing/render-app';
import { pausePage, success } from '../../testing/storage-browser-fixtures';

afterEach(() => vi.unstubAllGlobals());

async function setup(options: { multiple?: boolean; folder?: boolean } = {}) {
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
    kind: options.folder ? 'directory' : 'file',
    capabilities: { read: { support: 'supported' } },
  };
  const entries = [
    entry,
    ...(options.multiple
      ? [
          {
            ...entry,
            kind: 'file' as const,
            name: '另一个.txt',
            ref: { ...entry.ref, locator: 'second' },
          },
        ]
      : []),
  ];
  const items = entries.map((selected, id) => ({
    id,
    entry: selected,
    path: selected.name,
    targetPath: `D:\\Downloads\\${selected.name}`,
  }));
  const child = {
    id: 10,
    path: `${entry.name}/file.txt`,
    targetPath: `D:\\Downloads\\${entry.name}\\file.txt`,
    parent: entry.ref,
    entry: {
      ...entry,
      kind: 'file' as const,
      name: 'file.txt',
      ref: { ...entry.ref, locator: 'child' },
    },
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
      success({
        ref: { planId: 'single', itemId: 0 },
        path: `${request.directory}\\${request.expectedName}`,
      }),
    ),
    prepareBatch: vi.fn<DownloadsApi['prepareBatch']>(async (request) =>
      success({ id: 'batch', path: request.directory, conflicts: [], items }),
    ),
    confirmBatch: vi.fn<DownloadsApi['confirmBatch']>(async () => success(undefined)),
    releaseWork: vi.fn<DownloadsApi['releaseWork']>(async () => success(undefined)),
    releaseBatch: vi.fn<DownloadsApi['releaseBatch']>(async () => success(undefined)),
    discoverBatchDirectory: vi.fn<DownloadsApi['discoverBatchDirectory']>(async () =>
      success({ items: [child] }),
    ),
    resolveWork: vi.fn<DownloadsApi['resolveWork']>(async (ref) =>
      success({
        id: ref.planId === 'single' ? 'download' : `file-${ref.itemId}`,
        path: 'D:\\Downloads\\file.txt',
      }),
    ),
    cancelWork: vi.fn<DownloadsApi['cancelWork']>(async () => {
      pending.resolve({ ok: false, code: 'Cancelled' });
      return success(undefined);
    }),
    cancelBatchItem: vi.fn<DownloadsApi['cancelBatchItem']>(async () => success(undefined)),
    finishBatch: vi.fn<DownloadsApi['finishBatch']>(async () => success(undefined)),
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
      listDirectory: async () => success({ entries }),
    },
  });
  await renderWorkspace();
  await user.click(await screen.findByRole('button', { name: '云盘' }));
  if (options.multiple) {
    await user.click(await screen.findByRole('button', { name: entry.name }));
    await user.keyboard('{Control>}');
    await user.click(await screen.findByRole('button', { name: '另一个.txt' }));
    await user.keyboard('{/Control}');
  }
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
    entries,
    items,
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

it('downloads the entire multiple selection and releases its plan when cleared', async () => {
  const { user, modal, downloads, pending, entries } = await setup({ multiple: true });
  expect(modal.getByText('已选择 2 个文件和 0 个文件夹')).toBeInTheDocument();
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  expect(downloads.prepareBatch).toHaveBeenCalledExactlyOnceWith({
    directory: 'D:\\Downloads',
    entries: entries.map((entry) => ({ ref: entry.ref, expectedName: entry.name })),
  });
  await waitFor(() => expect(downloads.run).toHaveBeenCalledTimes(2));
  expect(downloads.run.mock.calls.map(([id]) => id).sort()).toEqual(['file-0', 'file-1']);
  expect(downloads.prepare).not.toHaveBeenCalled();
  const queue = within(screen.getByRole('region', { name: '任务队列' }));
  expect(queue.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
  expect(queue.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  await act(async () => {
    pending.resolve(success({ status: 'completed' }));
  });
  expect(await screen.findByLabelText('已完成')).toBeInTheDocument();
  expect(
    screen.getByText('共 2 项任务 · 已完成 2 项 · 失败 0 项 · 跳过 0 项 · 取消 0 项'),
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看明细' }));
  expect(queue.getAllByRole('listitem')).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: '清除已结束任务' }));
  expect(downloads.releaseBatch).toHaveBeenCalledWith('batch');
});

it('requires confirmation before transferring a conflicting folder', async () => {
  const { user, modal, downloads, pending, entry, items } = await setup({ folder: true });
  downloads.prepareBatch.mockResolvedValueOnce(
    success({ id: 'batch', path: 'D:\\Downloads', conflicts: [entry.name], items }),
  );
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const confirmation = within(await screen.findByRole('dialog', { name: '确认覆盖' }));
  expect(confirmation.getByText('已存在同名项目，是否覆盖？')).toBeInTheDocument();
  expect(confirmation.getByText(entry.name)).toBeInTheDocument();
  expect(downloads.run).not.toHaveBeenCalled();
  await user.click(confirmation.getByRole('button', { name: '覆盖并下载' }));
  expect(downloads.confirmBatch).toHaveBeenCalledExactlyOnceWith('batch');
  expect(downloads.prepareBatch).toHaveBeenCalledOnce();
  await waitFor(() => expect(downloads.run).toHaveBeenCalledOnce());
  await act(async () => {
    pending.resolve(success({ status: 'completed' }));
  });
});

it('releases a cancelled confirmation and leaves the editable folder download dialog open', async () => {
  const { user, modal, downloads, items } = await setup({ folder: true });
  downloads.prepareBatch.mockResolvedValueOnce(
    success({ id: 'batch', path: 'D:\\Downloads', conflicts: ['A'], items }),
  );
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const confirmation = within(await screen.findByRole('dialog', { name: '确认覆盖' }));
  await user.click(confirmation.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(modal.getByRole('button', { name: '开始下载' })).toBeEnabled());
  expect(downloads.releaseBatch).toHaveBeenCalledExactlyOnceWith('batch');
  expect(downloads.run).not.toHaveBeenCalled();
  expect(modal.getByRole('textbox', { name: '保存目录' })).toHaveValue('D:\\Downloads');
});

it('derives partial group results and only exposes retries on individual child tasks', async () => {
  const { user, modal, downloads } = await setup({ multiple: true });
  downloads.run.mockImplementation(async (id) =>
    id === 'file-0' ? success({ status: 'completed' }) : { ok: false, code: 'NetworkError' },
  );
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  expect(await screen.findByLabelText('部分完成')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看明细' }));
  downloads.run.mockResolvedValueOnce(success({ status: 'completed' }));
  await user.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByLabelText('部分完成')).not.toBeInTheDocument());
  expect(downloads.resolveWork.mock.calls.map(([ref]) => ref.itemId)).toEqual([0, 1, 1]);
  expect(downloads.prepareBatch).toHaveBeenCalledOnce();
});

it('retries standalone work without creating a group or preparing a different destination', async () => {
  const { user, modal, downloads } = await setup();
  downloads.run.mockResolvedValueOnce({ ok: false, code: 'NetworkError' });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const retry = await screen.findByRole('button', { name: '重试' });
  downloads.run.mockResolvedValueOnce(success({ status: 'completed' }));
  await user.click(retry);
  expect(await screen.findByLabelText('已完成')).toBeInTheDocument();
  expect(downloads.resolveWork.mock.calls.map(([ref]) => ref)).toEqual([
    { planId: 'single', itemId: 0 },
    { planId: 'single', itemId: 0 },
  ]);
  expect(downloads.prepare).toHaveBeenCalledOnce();
  expect(downloads.prepareBatch).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '查看明细' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '清除已结束任务' }));
  expect(downloads.releaseWork).toHaveBeenCalledExactlyOnceWith({ planId: 'single', itemId: 0 });
});

it('shows every member in an expanded group without pagination', async () => {
  const { user, modal, downloads, entry } = await setup({ folder: true });
  const children = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    path: `${entry.name}/task-${index + 1}.txt`,
    targetPath: `D:\\Downloads\\${entry.name}\\task-${index + 1}.txt`,
    parent: entry.ref,
    entry: {
      ...entry,
      kind: 'file' as const,
      name: `task-${index + 1}.txt`,
      ref: { ...entry.ref, locator: `child-${index + 1}` },
    },
  }));
  downloads.discoverBatchDirectory.mockImplementation(async (_id, _itemId, offset) =>
    success({
      items: children.slice(offset, offset + 32),
      ...(offset + 32 < children.length ? { nextOffset: offset + 32 } : {}),
    }),
  );
  downloads.run.mockResolvedValue(success({ status: 'completed' }));
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(downloads.finishBatch).toHaveBeenCalledWith('batch'));
  const queue = within(screen.getByRole('region', { name: '任务队列' }));
  expect(queue.getAllByRole('listitem')).toHaveLength(1);
  await user.click(queue.getByRole('button', { name: '查看明细' }));
  expect(queue.getAllByRole('listitem')).toHaveLength(102);
  expect(queue.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
  expect(queue.getByText(`${entry.name}/task-101.txt`)).toBeInTheDocument();
});

it('keeps the queue panel closed when discovery adds members to an existing group', async () => {
  const { user, modal, downloads, entry } = await setup({ folder: true });
  const discovering = pausePage<Awaited<ReturnType<DownloadsApi['discoverBatchDirectory']>>>();
  downloads.discoverBatchDirectory.mockReturnValueOnce(discovering.promise);
  downloads.run.mockResolvedValue(success({ status: 'completed' }));
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(downloads.discoverBatchDirectory).toHaveBeenCalledOnce());
  const panel = screen.getByRole('region', { name: '任务队列' });
  await user.click(within(panel).getByRole('button', { name: '关闭任务队列' }));
  await act(async () =>
    discovering.resolve(
      success({
        items: [
          {
            id: 1,
            path: 'A/file.txt',
            targetPath: 'D:\\Downloads\\A\\file.txt',
            entry: { ...entry, kind: 'file' },
          },
        ],
      }),
    ),
  );
  await waitFor(() => expect(downloads.finishBatch).toHaveBeenCalledWith('batch'));
  expect(panel).not.toBeVisible();
});

it('keeps folder preparation problems separate from download members', async () => {
  const { user, modal, downloads, pending, entry } = await setup({ folder: true, multiple: true });
  downloads.discoverBatchDirectory.mockResolvedValueOnce({ ok: false, code: 'PermissionDenied' });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(downloads.run).toHaveBeenCalledOnce());
  await act(async () => pending.resolve(success({ status: 'completed' })));
  expect(await screen.findByLabelText('部分完成')).toBeInTheDocument();
  expect(screen.getByText(/1 项准备问题/)).toBeInTheDocument();
  expect(
    screen.getByText('共 1 项任务 · 已完成 1 项 · 失败 0 项 · 跳过 0 项 · 取消 0 项'),
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看明细' }));
  const issues = within(screen.getByRole('list', { name: '准备问题' }));
  expect(issues.getByText(entry.name)).toBeInTheDocument();
  expect(issues.getByText('没有权限访问这个位置。')).toBeInTheDocument();
  expect(
    within(screen.getByRole('list', { name: '任务组成员' })).getAllByRole('listitem'),
  ).toHaveLength(1);
});

it('shows fatal preparation failure on the group without adding a failed member', async () => {
  const { user, modal, downloads } = await setup({ folder: true });
  downloads.discoverBatchDirectory.mockResolvedValueOnce({ ok: false, code: 'AuthRequired' });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  expect(await screen.findByText('准备失败')).toBeInTheDocument();
  expect(await screen.findByLabelText('失败')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看明细' }));
  expect(screen.getByRole('alert')).toHaveTextContent('请重新授权这个账号。');
  expect(
    within(screen.getByRole('list', { name: '任务组成员' })).queryAllByRole('listitem'),
  ).toHaveLength(0);
});

it('allows files to finish while preparation of other folders is still running', async () => {
  const { user, modal, downloads, pending, entry } = await setup({ folder: true });
  const later = pausePage<Awaited<ReturnType<DownloadsApi['discoverBatchDirectory']>>>();
  downloads.discoverBatchDirectory
    .mockResolvedValueOnce(
      success({
        items: [
          {
            id: 1,
            path: 'A/file.txt',
            targetPath: 'D:\\Downloads\\A\\file.txt',
            entry: { ...entry, kind: 'file', ref: { ...entry.ref, locator: 'child' } },
          },
          {
            id: 2,
            path: 'A/Sub',
            targetPath: 'D:\\Downloads\\A\\Sub',
            entry: { ...entry, name: 'Sub', ref: { ...entry.ref, locator: 'sub' } },
          },
        ],
      }),
    )
    .mockReturnValueOnce(later.promise);
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(downloads.run).toHaveBeenCalledOnce());
  await waitFor(() => expect(downloads.discoverBatchDirectory).toHaveBeenCalledTimes(2));
  await act(async () => pending.resolve(success({ status: 'completed' })));
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByText('正在准备')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '清除已结束任务' })).toBeDisabled();
  await act(async () => later.resolve(success({ items: [] })));
  expect(await screen.findByLabelText('已完成')).toBeInTheDocument();
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
  expect(downloads.cancelWork).toHaveBeenCalledWith({ planId: 'single', itemId: 0 });
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
