import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { DownloadsApi } from '../../../../shared/downloads';
import type { Entry, Space } from '../../../../shared/storage';
import type {
  StorageTaskGroupItem,
  StorageTaskItem,
  TaskControlAvailability,
} from '../../../../shared/tasks';
import { createFakeTasksApi } from '../../testing/fake-tasks-api';
import { renderWorkspace } from '../../testing/render-app';
import { success } from '../../testing/storage-browser-fixtures';

afterEach(() => vi.unstubAllGlobals());

const idleControls: TaskControlAvailability = {
  supportsPause: false,
  supportsCancel: false,
  canPause: false,
  canResume: false,
  canCancel: false,
  canRetry: false,
};

function makeGroup(
  id: number,
  names: string[],
  overrides: Partial<StorageTaskGroupItem> = {},
): StorageTaskGroupItem {
  return {
    id,
    request: {
      kind: 'download',
      input: { names, sourcePath: '云盘', destinationPath: 'D:\\Downloads' },
    },
    sealed: true,
    state: { phase: 'active' },
    summary: {
      total: 0,
      queued: 0,
      running: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    },
    progress: { kind: 'indeterminate', stage: { key: 'tasks:generatingTasks' } },
    preparation: { status: 'completed', issues: [] },
    ...overrides,
  };
}

function makeDownloadTask(
  id: number,
  parent: Space['root'],
  entry: Entry,
  overrides: Partial<StorageTaskItem> = {},
): StorageTaskItem {
  return {
    id,
    request: {
      type: 'download',
      input: {
        parent,
        entry,
        directoryPath: '云盘',
        destinationPath: `D:\\Downloads\\${entry.name}`,
      },
    },
    status: 'running',
    controls: idleControls,
    ...overrides,
  };
}

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
    capabilities: options.folder
      ? { list: { support: 'supported' } }
      : { read: { support: 'supported' } },
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
            capabilities: { read: { support: 'supported' as const } },
          },
        ]
      : []),
  ];
  const downloads: Pick<DownloadsApi, 'getSettings' | 'chooseDirectory'> = {
    getSettings: vi.fn<DownloadsApi['getSettings']>(async () =>
      success({
        directory: 'D:\\Downloads',
      }),
    ),
    chooseDirectory: vi.fn<DownloadsApi['chooseDirectory']>(async () => success(null)),
  };
  const fakeTasks = createFakeTasksApi();
  vi.stubGlobal('desktop', {
    downloads,
    tasks: fakeTasks.api,
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
    space,
    entry,
    entries,
    modal,
    dialog,
    downloads,
    tasksApi: fakeTasks.api,
    emitSnapshot: (tasks: StorageTaskItem[], groups: StorageTaskGroupItem[] = []) =>
      act(() => {
        fakeTasks.setSnapshot({ tasks, groups });
      }),
  };
}

it('opens an editable overlay and starts a background download without opening the directory picker', async () => {
  const { user, space, entry, modal, downloads, tasksApi, emitSnapshot } = await setup();
  expect(downloads.chooseDirectory).not.toHaveBeenCalled();
  const directory = modal.getByRole('textbox', { name: '保存目录' });
  await user.clear(directory);
  await user.type(directory, 'E:\\Saved');
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  expect(tasksApi.prepareDownload).toHaveBeenCalledExactlyOnceWith({
    parent: space.root,
    entries: [entry],
    directory: 'E:\\Saved',
    directoryPath: '云盘',
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      controls: { ...idleControls, supportsPause: true, supportsCancel: true, canCancel: true },
    }),
  ]);
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      controls: {
        ...idleControls,
        supportsPause: true,
        supportsCancel: true,
        canPause: true,
        canCancel: true,
      },
      progress: {
        kind: 'indeterminate',
        stage: { key: 'storage:downloadReceiving' },
        completedBytes: 1536,
        bytesPerSecond: 2048,
      },
    }),
  ]);
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('value');
  expect(screen.getByText('1.5 KiB')).toBeInTheDocument();
  expect(screen.getByLabelText('当前速率')).toHaveTextContent('2 KiB/s');

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      controls: {
        ...idleControls,
        supportsPause: true,
        supportsCancel: true,
        canPause: true,
        canCancel: true,
      },
      progress: {
        kind: 'determinate',
        stage: { key: 'storage:downloadReceiving' },
        completed: 4,
        total: 10,
        unit: 'bytes',
        bytesPerSecond: 1024 ** 2,
      },
    }),
  ]);
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '4');
  expect(screen.getByLabelText('当前速率')).toHaveTextContent('1 MiB/s');

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      controls: { ...idleControls, supportsPause: true, supportsCancel: true },
      progress: {
        kind: 'determinate',
        stage: { key: 'storage:downloadSaving' },
        completed: 10,
        total: 10,
        unit: 'bytes',
      },
    }),
  ]);
  expect(screen.queryByLabelText('当前速率')).not.toBeInTheDocument();
  const queue = within(screen.getByRole('region', { name: '任务队列' }));
  expect(queue.getByRole('button', { name: '取消' })).toBeDisabled();

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      status: 'completed',
      controls: { ...idleControls, supportsPause: true, supportsCancel: true },
    }),
  ]);
  expect(await queue.findByLabelText('已完成')).toBeInTheDocument();
  expect(queue.getByRole('button', { name: '暂停' })).toBeDisabled();
  expect(queue.getByRole('button', { name: '取消' })).toBeDisabled();
});

it('downloads the entire multiple selection and clears finished history as a whole', async () => {
  const { user, space, entries, modal, tasksApi, emitSnapshot } = await setup({ multiple: true });
  expect(modal.getByText('已选择 2 个文件和 0 个文件夹')).toBeInTheDocument();
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  expect(tasksApi.prepareDownload).toHaveBeenCalledExactlyOnceWith({
    parent: space.root,
    entries,
    directory: 'D:\\Downloads',
    directoryPath: '云盘',
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  const children = entries.map((item, index) =>
    makeDownloadTask(index + 2, space.root, item, { groupId: 1 }),
  );
  emitSnapshot(children, [
    makeGroup(
      1,
      entries.map((item) => item.name),
      {
        summary: {
          total: 2,
          queued: 0,
          running: 2,
          paused: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          skipped: 0,
        },
      },
    ),
  ]);

  const queue = within(screen.getByRole('region', { name: '任务队列' }));
  expect(queue.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
  expect(queue.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();

  emitSnapshot(
    children.map((child) => ({ ...child, status: 'completed' })),
    [
      makeGroup(
        1,
        entries.map((item) => item.name),
        {
          state: { phase: 'settled', outcome: 'completed' },
          summary: {
            total: 2,
            queued: 0,
            running: 0,
            paused: 0,
            completed: 2,
            failed: 0,
            cancelled: 0,
            skipped: 0,
          },
        },
      ),
    ],
  );
  expect(await screen.findByLabelText('已完成')).toBeInTheDocument();
  expect(
    screen.getByText('共 2 项任务 · 已完成 2 项 · 失败 0 项 · 跳过 0 项 · 取消 0 项'),
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看明细' }));
  expect(queue.getAllByRole('listitem')).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: '清除已结束任务' }));
  expect(tasksApi.clearFinished).toHaveBeenCalledOnce();
});

it('requires confirmation before transferring a conflicting folder', async () => {
  const { user, modal, tasksApi, entry } = await setup({ folder: true });
  vi.mocked(tasksApi.prepareDownload).mockResolvedValueOnce(
    success({ status: 'conflict', confirmationId: 'confirm-folder', conflicts: [entry.name] }),
  );
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const confirmation = within(await screen.findByRole('dialog', { name: '确认覆盖' }));
  expect(confirmation.getByText('已存在同名项目，是否覆盖？')).toBeInTheDocument();
  expect(confirmation.getByText(entry.name)).toBeInTheDocument();
  expect(tasksApi.confirmDownload).not.toHaveBeenCalled();
  await user.click(confirmation.getByRole('button', { name: '覆盖并下载' }));
  expect(tasksApi.confirmDownload).toHaveBeenCalledExactlyOnceWith('confirm-folder');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('releases a cancelled confirmation and leaves the editable folder download dialog open', async () => {
  const { user, modal, tasksApi } = await setup({ folder: true });
  vi.mocked(tasksApi.prepareDownload).mockResolvedValueOnce(
    success({ status: 'conflict', confirmationId: 'confirm-cancel', conflicts: ['A'] }),
  );
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const confirmation = within(await screen.findByRole('dialog', { name: '确认覆盖' }));
  await user.click(confirmation.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(modal.getByRole('button', { name: '开始下载' })).toBeEnabled());
  expect(tasksApi.cancelDownloadConfirmation).toHaveBeenCalledExactlyOnceWith('confirm-cancel');
  expect(tasksApi.confirmDownload).not.toHaveBeenCalled();
  expect(modal.getByRole('textbox', { name: '保存目录' })).toHaveValue('D:\\Downloads');
});

it('derives partial group results and only exposes retries on individual child tasks', async () => {
  const { user, space, entries, modal, tasksApi, emitSnapshot } = await setup({ multiple: true });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const firstChild = makeDownloadTask(2, space.root, entries[0]!, {
    groupId: 1,
    status: 'completed',
  });
  const secondChild = makeDownloadTask(3, space.root, entries[1]!, {
    groupId: 1,
    status: 'failed',
    failure: { code: 'NetworkError', message: { key: 'errors:NetworkError' } },
    controls: { ...idleControls, canRetry: true },
  });
  emitSnapshot(
    [firstChild, secondChild],
    [
      makeGroup(
        1,
        entries.map((item) => item.name),
        {
          state: { phase: 'settled', outcome: 'partial' },
          summary: {
            total: 2,
            queued: 0,
            running: 0,
            paused: 0,
            completed: 1,
            failed: 1,
            cancelled: 0,
            skipped: 0,
          },
        },
      ),
    ],
  );
  expect(await screen.findByLabelText('部分完成')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看明细' }));
  await user.click(screen.getByRole('button', { name: '重试' }));
  expect(tasksApi.retry).toHaveBeenCalledExactlyOnceWith(3);

  emitSnapshot(
    [
      firstChild,
      { ...secondChild, status: 'completed', failure: undefined, controls: idleControls },
    ],
    [
      makeGroup(
        1,
        entries.map((item) => item.name),
        {
          state: { phase: 'settled', outcome: 'completed' },
          summary: {
            total: 2,
            queued: 0,
            running: 0,
            paused: 0,
            completed: 2,
            failed: 0,
            cancelled: 0,
            skipped: 0,
          },
        },
      ),
    ],
  );
  await waitFor(() => expect(screen.queryByLabelText('部分完成')).not.toBeInTheDocument());
});

it('retries standalone work without creating a group or preparing a different destination', async () => {
  const { user, space, entry, modal, tasksApi, emitSnapshot } = await setup();
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const failedTask = makeDownloadTask(1, space.root, entry, {
    status: 'failed',
    failure: { code: 'NetworkError', message: { key: 'errors:NetworkError' } },
    controls: { ...idleControls, canRetry: true },
  });
  emitSnapshot([failedTask]);

  const retry = await screen.findByRole('button', { name: '重试' });
  await user.click(retry);
  expect(tasksApi.retry).toHaveBeenCalledExactlyOnceWith(1);

  emitSnapshot([
    { ...failedTask, status: 'completed', failure: undefined, controls: idleControls },
  ]);
  expect(await screen.findByLabelText('已完成')).toBeInTheDocument();
  expect(tasksApi.prepareDownload).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: '查看明细' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '清除已结束任务' }));
  expect(tasksApi.clearFinished).toHaveBeenCalledOnce();
});

it('shows every member in an expanded group without pagination', async () => {
  const { user, entry, modal, emitSnapshot } = await setup({ folder: true });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const children = Array.from({ length: 101 }, (_, index) =>
    makeDownloadTask(
      index + 2,
      entry.ref,
      {
        ...entry,
        kind: 'file',
        name: `task-${index + 1}.txt`,
        ref: { ...entry.ref, locator: `child-${index + 1}` },
      },
      {
        groupId: 1,
        status: 'completed',
        request: {
          type: 'download',
          input: {
            parent: entry.ref,
            entry: {
              ...entry,
              kind: 'file',
              name: `task-${index + 1}.txt`,
              ref: { ...entry.ref, locator: `child-${index + 1}` },
            },
            directoryPath: '云盘',
            destinationPath: `D:\\Downloads\\${entry.name}\\task-${index + 1}.txt`,
            displayName: `${entry.name}/task-${index + 1}.txt`,
          },
        },
      },
    ),
  );
  emitSnapshot(children, [
    makeGroup(1, [entry.name], {
      state: { phase: 'settled', outcome: 'completed' },
      summary: {
        total: 101,
        queued: 0,
        running: 0,
        paused: 0,
        completed: 101,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      },
    }),
  ]);
  const queue = within(screen.getByRole('region', { name: '任务队列' }));
  expect(queue.getAllByRole('listitem')).toHaveLength(1);
  await user.click(queue.getByRole('button', { name: '查看明细' }));
  expect(queue.getAllByRole('listitem')).toHaveLength(102);
  expect(queue.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
  expect(queue.getByText(`${entry.name}/task-101.txt`)).toBeInTheDocument();
});

it('keeps the queue panel closed when discovery updates add members to an existing group', async () => {
  const { user, space, entry, modal, emitSnapshot } = await setup({ folder: true });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const group = makeGroup(1, [entry.name], {
    sealed: false,
    preparation: { status: 'running', issues: [] },
  });
  emitSnapshot([], [group]);

  const panel = screen.getByRole('region', { name: '任务队列' });
  await user.click(within(panel).getByRole('button', { name: '关闭任务队列' }));

  const member = makeDownloadTask(
    2,
    space.root,
    { ...entry, kind: 'file' },
    {
      groupId: 1,
      status: 'completed',
    },
  );
  emitSnapshot(
    [member],
    [
      makeGroup(1, [entry.name], {
        state: { phase: 'settled', outcome: 'completed' },
        summary: { ...group.summary, total: 1, completed: 1 },
      }),
    ],
  );
  expect(panel).not.toBeVisible();
});

it('keeps folder preparation problems separate from download members', async () => {
  const { user, space, entry, entries, modal, emitSnapshot } = await setup({
    folder: true,
    multiple: true,
  });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const member = makeDownloadTask(2, space.root, entries[1]!, {
    groupId: 1,
    status: 'completed',
  });
  emitSnapshot(
    [member],
    [
      makeGroup(
        1,
        entries.map((item) => item.name),
        {
          state: { phase: 'settled', outcome: 'partial' },
          summary: {
            total: 1,
            queued: 0,
            running: 0,
            paused: 0,
            completed: 1,
            failed: 0,
            cancelled: 0,
            skipped: 0,
          },
          preparation: {
            status: 'completed',
            issues: [
              {
                label: entry.name,
                failure: { code: 'PermissionDenied', message: { key: 'errors:PermissionDenied' } },
              },
            ],
          },
        },
      ),
    ],
  );
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
  const { user, entry, modal, emitSnapshot } = await setup({ folder: true });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  emitSnapshot(
    [],
    [
      makeGroup(1, [entry.name], {
        state: { phase: 'settled', outcome: 'failed' },
        preparation: {
          status: 'failed',
          issues: [],
          failure: { code: 'AuthRequired', message: { key: 'errors:AuthRequired' } },
        },
      }),
    ],
  );
  expect(await screen.findByText('准备失败')).toBeInTheDocument();
  expect(await screen.findByLabelText('失败')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看明细' }));
  expect(screen.getByRole('alert')).toHaveTextContent('请重新授权这个账号。');
  expect(
    within(screen.getByRole('list', { name: '任务组成员' })).queryAllByRole('listitem'),
  ).toHaveLength(0);
});

it('allows files to finish while preparation of other folders is still running', async () => {
  const { user, entry, modal, emitSnapshot } = await setup({ folder: true });
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const child = makeDownloadTask(
    2,
    entry.ref,
    { ...entry, kind: 'file', ref: { ...entry.ref, locator: 'child' } },
    { groupId: 1, status: 'completed' },
  );
  const group = makeGroup(1, [entry.name], {
    sealed: false,
    state: { phase: 'active' },
    summary: {
      total: 1,
      queued: 0,
      running: 0,
      paused: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    },
    preparation: { status: 'running', issues: [] },
  });
  emitSnapshot([child], [group]);
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByText('正在准备')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '清除已结束任务' })).toBeDisabled();

  emitSnapshot(
    [child],
    [
      {
        ...group,
        sealed: true,
        state: { phase: 'settled', outcome: 'completed' },
        preparation: { status: 'completed', issues: [] },
      },
    ],
  );
  expect(await screen.findByLabelText('已完成')).toBeInTheDocument();
});

it('requires explicit replacement confirmation while retaining the download dialog underneath', async () => {
  const { user, modal, dialog, tasksApi } = await setup();
  vi.mocked(tasksApi.prepareDownload).mockResolvedValueOnce(
    success({ status: 'conflict', confirmationId: 'confirm-file' }),
  );
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const confirmation = within(await screen.findByRole('dialog', { name: '确认覆盖' }));
  expect(confirmation.getByText('已存在同名文件，是否覆盖？')).toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  expect(modal.getByRole('button', { name: '开始下载' })).toBeDisabled();
  expect(modal.getByRole('textbox', { name: '保存目录' })).toBeDisabled();
  expect(tasksApi.confirmDownload).not.toHaveBeenCalled();
  expect(tasksApi.prepareDownload).toHaveBeenCalledOnce();
  await user.click(confirmation.getByRole('button', { name: '覆盖并下载' }));
  expect(tasksApi.confirmDownload).toHaveBeenCalledExactlyOnceWith('confirm-file');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('cancels a running transfer and disables active controls', async () => {
  const { user, space, entry, modal, tasksApi, emitSnapshot } = await setup();
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const running = makeDownloadTask(1, space.root, entry, {
    controls: {
      ...idleControls,
      supportsPause: true,
      supportsCancel: true,
      canCancel: true,
    },
  });
  emitSnapshot([running]);
  const queue = within(await screen.findByRole('region', { name: '任务队列' }));
  await user.click(await queue.findByRole('button', { name: '取消' }));
  expect(tasksApi.cancel).toHaveBeenCalledExactlyOnceWith(1);

  emitSnapshot([
    {
      ...running,
      status: 'cancelled',
      controls: { ...idleControls, supportsPause: true, supportsCancel: true },
    },
  ]);
  expect(await queue.findByLabelText('已取消')).toBeInTheDocument();
  expect(queue.getByRole('button', { name: '暂停' })).toBeDisabled();
  expect(queue.getByRole('button', { name: '取消' })).toBeDisabled();
  expect(tasksApi.prepareDownload).toHaveBeenCalledOnce();
});

it('toggles pause and resume controls from task control state and shows paused status', async () => {
  const { user, space, entry, modal, tasksApi, emitSnapshot } = await setup();
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      controls: { ...idleControls, supportsPause: true, supportsCancel: true, canCancel: true },
    }),
  ]);
  const queue = within(screen.getByRole('region', { name: '任务队列' }));
  const pauseButton = queue.getByRole('button', { name: '暂停' });
  const cancelButton = queue.getByRole('button', { name: '取消' });
  expect(pauseButton).toBeDisabled();

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      controls: {
        ...idleControls,
        supportsPause: true,
        supportsCancel: true,
        canPause: true,
        canCancel: true,
      },
      progress: {
        kind: 'determinate',
        stage: { key: 'storage:downloadReceiving' },
        completed: 4,
        total: 10,
        unit: 'bytes',
      },
    }),
  ]);
  expect(pauseButton).toBeEnabled();

  await user.click(pauseButton);
  expect(tasksApi.pause).toHaveBeenCalledExactlyOnceWith(1);
  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      controlRequest: 'pause',
      controls: { ...idleControls, supportsPause: true, supportsCancel: true },
      progress: {
        kind: 'determinate',
        stage: { key: 'storage:downloadReceiving' },
        completed: 4,
        total: 10,
        unit: 'bytes',
      },
    }),
  ]);
  expect(queue.getByLabelText('正在暂停…')).toBeInTheDocument();
  expect(queue.getByRole('button', { name: '暂停' })).toBe(pauseButton);
  expect(pauseButton).toBeDisabled();
  expect(queue.getByRole('button', { name: '取消' })).toBe(cancelButton);
  expect(cancelButton).toBeDisabled();

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      status: 'paused',
      controls: {
        ...idleControls,
        supportsPause: true,
        supportsCancel: true,
        canResume: true,
        canCancel: true,
      },
      progress: { kind: 'determinate', completed: 4, total: 10, unit: 'bytes' },
    }),
  ]);
  expect(await queue.findByLabelText('已暂停')).toBeInTheDocument();
  expect(queue.getByRole('button', { name: '继续' })).toBe(pauseButton);
  expect(pauseButton).toBeEnabled();
  expect(cancelButton).toBeEnabled();
  expect(queue.getByRole('progressbar')).toHaveAttribute('value', '4');
  expect(screen.getByRole('contentinfo', { name: '状态栏' })).toHaveTextContent('1 项已暂停');
  expect(queue.getByRole('button', { name: '清除已结束任务' })).toBeDisabled();

  await user.click(queue.getByRole('button', { name: '继续' }));
  expect(tasksApi.resume).toHaveBeenCalledExactlyOnceWith(1);

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      controls: {
        ...idleControls,
        supportsPause: true,
        supportsCancel: true,
        canPause: true,
        canCancel: true,
      },
      progress: {
        kind: 'determinate',
        stage: { key: 'storage:downloadReceiving' },
        completed: 8,
        total: 10,
        unit: 'bytes',
      },
    }),
  ]);
  expect(queue.getByRole('progressbar')).toHaveAttribute('value', '8');
  expect(pauseButton).toBeEnabled();

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      controls: { ...idleControls, supportsPause: true, supportsCancel: true },
      progress: {
        kind: 'determinate',
        stage: { key: 'storage:downloadSaving' },
        completed: 10,
        total: 10,
        unit: 'bytes',
      },
    }),
  ]);
  expect(pauseButton).toBeDisabled();
  expect(cancelButton).toBeDisabled();

  emitSnapshot([
    makeDownloadTask(1, space.root, entry, {
      status: 'completed',
      controls: { ...idleControls, supportsPause: true, supportsCancel: true },
    }),
  ]);
  expect(await queue.findByLabelText('已完成')).toBeInTheDocument();
  expect(queue.getByRole('button', { name: '暂停' })).toBe(pauseButton);
  expect(queue.getByRole('button', { name: '取消' })).toBe(cancelButton);
  expect(pauseButton).toBeDisabled();
  expect(cancelButton).toBeDisabled();
  expect(queue.getAllByRole('listitem')).toHaveLength(1);
});

it('only dismisses the top confirmation when Escape is pressed', async () => {
  const { user, modal, tasksApi } = await setup();
  vi.mocked(tasksApi.prepareDownload).mockResolvedValueOnce(
    success({ status: 'conflict', confirmationId: 'confirm-escape' }),
  );
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  await screen.findByRole('dialog', { name: '确认覆盖' });
  await user.keyboard('{Escape}');
  const restored = within(await screen.findByRole('dialog', { name: '下载…' }));
  expect(restored.getByRole('textbox', { name: '保存目录' })).toHaveValue('D:\\Downloads');
  expect(restored.getByRole('textbox', { name: '保存目录' })).toBeEnabled();
  expect(screen.queryByRole('dialog', { name: '确认覆盖' })).not.toBeInTheDocument();
  expect(tasksApi.cancelDownloadConfirmation).toHaveBeenCalledExactlyOnceWith('confirm-escape');
  expect(tasksApi.confirmDownload).not.toHaveBeenCalled();
});

it('returns to directory editing without authorizing an overwrite', async () => {
  const { user, space, entry, modal, tasksApi } = await setup();
  vi.mocked(tasksApi.prepareDownload).mockResolvedValueOnce(
    success({ status: 'conflict', confirmationId: 'confirm-edit' }),
  );
  await user.click(modal.getByRole('button', { name: '开始下载' }));
  const confirmation = within(await screen.findByRole('dialog', { name: '确认覆盖' }));
  await user.click(confirmation.getByRole('button', { name: '取消' }));
  const restored = within(await screen.findByRole('dialog', { name: '下载…' }));
  const directory = restored.getByRole('textbox', { name: '保存目录' });
  expect(directory).toHaveValue('D:\\Downloads');
  expect(tasksApi.cancelDownloadConfirmation).toHaveBeenCalledExactlyOnceWith('confirm-edit');
  expect(tasksApi.confirmDownload).not.toHaveBeenCalled();
  await user.clear(directory);
  await user.type(directory, 'E:\\Other');
  await user.click(restored.getByRole('button', { name: '开始下载' }));
  expect(tasksApi.prepareDownload).toHaveBeenLastCalledWith({
    parent: space.root,
    entries: [entry],
    directory: 'E:\\Other',
    directoryPath: '云盘',
  });
});
