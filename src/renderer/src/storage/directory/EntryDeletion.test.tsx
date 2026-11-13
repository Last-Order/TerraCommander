import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Entry, Space } from '../../../../shared/storage';
import {
  emptyLocalConnection,
  type BrowserResult,
  type StorageBrowserApi,
} from '../../../../shared/storage-browser';
import { renderWorkspace } from '../../testing/render-app';
import { pausePage, success } from '../../testing/storage-browser-fixtures';

afterEach(() => vi.unstubAllGlobals());

async function setup(
  kind: Entry['kind'] = 'file',
  {
    capabilities,
    drive = 'local',
  }: { capabilities?: Entry['capabilities']; drive?: 'local' | 'personal' | 'shared' } = {},
) {
  const user = userEvent.setup();
  const connectionId = drive === 'local' ? 'local' : 'studio';
  const spaceId = drive === 'shared' ? 'shared:team' : drive === 'personal' ? 'my-drive' : 'disk';
  const space = {
    id: spaceId,
    connectionId,
    name: '项目盘',
    root: {
      connectionId,
      spaceId,
      locator: drive === 'shared' ? 'team' : drive === 'personal' ? 'root' : '.',
    },
  } satisfies Space;
  const file: Entry = {
    ref: { ...space.root, locator: 'notes.txt' },
    name: '笔记.txt',
    kind,
    capabilities: capabilities ?? {
      remove: { support: 'supported' },
      rename: { support: 'supported' },
    },
  };
  const other: Entry = { ...file, ref: { ...file.ref, locator: 'other.txt' }, name: '其他.txt' };
  const entries = [file, other];
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async () =>
    success({ entries: [...entries] }),
  );
  const deleteEntry = vi.fn<StorageBrowserApi['deleteEntry']>(async (ref) => {
    const index = entries.findIndex((entry) => entry.ref.locator === ref.locator);
    if (index < 0) return { ok: false, code: 'NotFound' };
    entries.splice(index, 1);
    return success(undefined);
  });
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () =>
        success([
          {
            ...emptyLocalConnection,
            id: space.connectionId,
            provider: drive === 'local' ? 'local' : 'google-drive',
            spaces: [space],
          },
        ]),
      listDirectory,
      deleteEntry,
    },
  });
  await renderWorkspace();
  await user.click(await screen.findByRole('button', { name: space.name }));
  await screen.findByRole('button', { name: file.name });
  const openMenu = async (name = file.name) => {
    await user.pointer({ target: screen.getByRole('button', { name }), keys: '[MouseRight]' });
    await screen.findByRole('menuitem', { name: '信息' });
  };
  const openDelete = async () => {
    await openMenu();
    await user.click(screen.getByRole('menuitem', { name: '删除' }));
    return within(await screen.findByRole('dialog', { name: '删除' }));
  };
  return { user, space, file, other, entries, listDirectory, deleteEntry, openMenu, openDelete };
}

it('requires confirmation and cancels without submitting a deletion', async () => {
  const { user, file, deleteEntry, openDelete } = await setup();
  const dialog = await openDelete();
  expect(dialog.getByText(`确定删除“${file.name}”吗？删除后不可恢复。`)).toBeInTheDocument();
  const cancel = dialog.getByRole('button', { name: '取消' });
  await waitFor(() => expect(cancel).toHaveFocus());
  expect(deleteEntry).not.toHaveBeenCalled();
  await user.click(cancel);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(deleteEntry).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: file.name })).toBeInTheDocument();
});

it.each(['file', 'link'] as const)(
  'deletes only the right-clicked %s and updates the cached listing',
  async (kind) => {
    const { user, space, file, other, deleteEntry, listDirectory, openDelete } = await setup(kind);
    await user.click(screen.getByRole('button', { name: other.name }));
    const dialog = await openDelete();
    await user.click(dialog.getByRole('button', { name: '删除' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: file.name })).not.toBeInTheDocument(),
    );
    expect(deleteEntry).toHaveBeenCalledExactlyOnceWith(file.ref);
    expect(screen.getByRole('button', { name: other.name })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: space.name }));
    expect(screen.queryByRole('button', { name: file.name })).not.toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '任务队列' }));
    const queue = within(screen.getByRole('region', { name: '任务队列' }));
    expect(queue.getByText(file.name)).toBeInTheDocument();
    expect(queue.getByText('删除')).toBeInTheDocument();
    expect(queue.getByText('已完成')).toBeInTheDocument();
  },
);

it('hides deletion for multiple selected entries', async () => {
  const { user, file, other, openMenu, deleteEntry } = await setup();
  await user.click(screen.getByRole('button', { name: file.name }));
  await user.keyboard('{Control>}');
  await user.click(screen.getByRole('button', { name: other.name }));
  await user.keyboard('{/Control}');
  await openMenu();
  expect(screen.queryByRole('menuitem', { name: '删除' })).not.toBeInTheDocument();
  expect(deleteEntry).not.toHaveBeenCalled();
});

it.each(['personal', 'shared'] as const)(
  'deletes a %s Drive file with an irreversible warning',
  async (drive) => {
    const { user, file, deleteEntry, openDelete } = await setup('file', {
      drive,
      capabilities: { remove: { support: 'supported' } },
    });
    const dialog = await openDelete();
    expect(dialog.getByText(`确定删除“${file.name}”吗？删除后不可恢复。`)).toBeInTheDocument();
    expect(dialog.queryByText(/可在存储服务的回收站中恢复/)).not.toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: '删除' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: file.name })).not.toBeInTheDocument(),
    );
    expect(deleteEntry).toHaveBeenCalledExactlyOnceWith(file.ref);
  },
);

it.each(['personal', 'shared'] as const)(
  'hides deletion for a %s Drive file when the adapter reports removal is unsupported',
  async (drive) => {
    const { openMenu } = await setup('file', {
      drive,
      capabilities: { remove: { support: 'unsupported' } },
    });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: '删除' })).not.toBeInTheDocument();
  },
);

it.each(['directory', 'other'] as const)('hides deletion for a selected %s', async (kind) => {
  const { openMenu } = await setup(kind);
  await openMenu();
  expect(screen.queryByRole('menuitem', { name: '删除' })).not.toBeInTheDocument();
});

it('hides deletion when the provider reports it is unsupported', async () => {
  const { user, entries, file, openMenu } = await setup();
  entries[0] = { ...file, capabilities: { remove: { support: 'unsupported' } } };
  await user.click(screen.getByRole('button', { name: '刷新目录' }));
  await openMenu();
  expect(screen.queryByRole('menuitem', { name: '删除' })).not.toBeInTheDocument();
});

it('locks writes while deletion runs and completes after reopening the directory', async () => {
  const { user, space, file, entries, deleteEntry, openDelete, openMenu } = await setup();
  const pending = pausePage<BrowserResult<void>>();
  deleteEntry.mockReturnValueOnce(pending.promise);
  const dialog = await openDelete();
  await user.click(dialog.getByRole('button', { name: '删除' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: file.name }).closest('tr')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await user.click(screen.getByRole('button', { name: space.name }));
  await openMenu();
  expect(screen.getByRole('menuitem', { name: '删除' })).toHaveAttribute('data-disabled', 'true');
  expect(screen.getByRole('menuitem', { name: '重命名' })).toHaveAttribute('data-disabled', 'true');
  await user.keyboard('{Escape}');
  await user.keyboard('{F2}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  entries.splice(0, 1);
  await act(async () => pending.resolve(success(undefined)));
  expect(screen.queryByRole('button', { name: file.name })).not.toBeInTheDocument();
  expect(deleteEntry).toHaveBeenCalledOnce();
});

it('retains the file and displays the failure when deletion fails', async () => {
  const { user, file, deleteEntry, openDelete, openMenu } = await setup();
  deleteEntry.mockResolvedValueOnce({ ok: false, code: 'PermissionDenied' });
  const dialog = await openDelete();
  await user.click(dialog.getByRole('button', { name: '删除' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: file.name }).closest('tr')).not.toHaveAttribute(
      'aria-busy',
    ),
  );
  await user.click(screen.getByRole('button', { name: '任务队列' }));
  expect(await screen.findByText('没有权限访问这个位置。')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '关闭任务队列' }));
  await openMenu();
  expect(screen.getByRole('menuitem', { name: '删除' })).not.toHaveAttribute('data-disabled');
});

it('does not restore a deleted file from an older in-flight refresh', async () => {
  const { user, file, other, listDirectory, openDelete } = await setup();
  const pending = pausePage<Awaited<ReturnType<StorageBrowserApi['listDirectory']>>>();
  listDirectory.mockReturnValueOnce(pending.promise);
  await user.click(screen.getByRole('button', { name: '刷新目录' }));
  const dialog = await openDelete();
  await user.click(dialog.getByRole('button', { name: '删除' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: file.name })).not.toBeInTheDocument(),
  );
  await act(async () => pending.resolve(success({ entries: [file, other] })));
  expect(screen.queryByRole('button', { name: file.name })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: other.name })).toBeInTheDocument();
});
