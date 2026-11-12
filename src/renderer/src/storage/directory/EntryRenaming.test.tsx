import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Entry, Space } from '../../../../shared/storage';
import {
  emptyLocalConnection,
  localConnectionId,
  type BrowserResult,
  type StorageBrowserApi,
} from '../../../../shared/storage-browser';
import { renderWorkspace } from '../../testing/render-app';
import { pausePage, success } from '../../testing/storage-browser-fixtures';
import { DirectoryPane } from './DirectoryPane';
import { DirectoryTable } from './DirectoryTable';

vi.mock('./DirectoryPane', { spy: true });
vi.mock('./DirectoryTable', { spy: true });

afterEach(() => vi.unstubAllGlobals());

async function setup(kind: Entry['kind'] = 'file') {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const file: Entry = {
    ref: { ...space.root, locator: 'notes.txt' },
    name: '笔记.txt',
    kind,
    capabilities: { rename: { support: 'supported' } },
  };
  const other: Entry = {
    ...file,
    ref: { ...space.root, locator: 'other.txt' },
    name: '其他.txt',
  };
  const entries = [file, other];
  const archive = {
    ...space,
    id: 'archive',
    name: '归档盘',
    root: { ...space.root, spaceId: 'archive' },
  };
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (parent) =>
    success({ entries: parent.spaceId === space.id ? entries : [] }),
  );
  const renameEntry = vi.fn<StorageBrowserApi['renameEntry']>(async (ref, name) => {
    const index = entries.findIndex((entry) => entry.ref.locator === ref.locator);
    const entry = entries[index];
    if (!entry) return { ok: false, code: 'NotFound' };
    const renamed = { ...entry, ref: { ...ref, locator: name }, name };
    entries[index] = renamed;
    return success(renamed);
  });
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () => success([{ ...emptyLocalConnection, spaces: [space, archive] }]),
      listDirectory,
      renameEntry,
    },
  });
  await renderWorkspace();
  await user.click(await screen.findByRole('button', { name: space.name }));
  await screen.findByRole('button', { name: file.name });
  const openRename = async () => {
    await user.pointer({
      target: screen.getByRole('button', { name: file.name }),
      keys: '[MouseRight]',
    });
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
    return within(await screen.findByRole('dialog', { name: '重命名' }));
  };
  return { user, file, other, entries, listDirectory, renameEntry, openRename };
}

it('renames a single right-clicked file in place without reloading the listing', async () => {
  const { user, file, other, renameEntry, listDirectory, openRename } = await setup();
  const dialog = await openRename();
  const input = dialog.getByRole('textbox', { name: '名称' });
  expect(input).toHaveValue(file.name);
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveProperty('selectionStart', 0);
  expect(input).toHaveProperty('selectionEnd', file.name.lastIndexOf('.'));
  await user.keyboard('{Control>}a{/Control}');
  expect(input).toHaveProperty('selectionEnd', file.name.length);
  expect(screen.getByRole('button', { name: other.name })).toHaveAttribute('aria-pressed', 'false');
  expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();
  await user.clear(input);
  expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();
  const table = within(screen.getByRole('table', { name: '文件和文件夹' }));
  await user.type(input, '新笔记.txt{Enter}');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '新笔记.txt' }).closest('tr')).not.toHaveAttribute(
      'aria-busy',
    ),
  );
  expect(renameEntry).toHaveBeenCalledExactlyOnceWith(file.ref, '新笔记.txt');
  expect(
    table
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getByRole('button').textContent),
  ).toEqual(['新笔记.txt', other.name]);
  expect(listDirectory).toHaveBeenCalledTimes(1);
  await user.keyboard('{Shift>}');
  await user.click(table.getByRole('button', { name: other.name }));
  await user.keyboard('{/Shift}');
  expect(table.getByRole('button', { name: '新笔记.txt' })).toHaveAttribute('aria-pressed', 'true');
  expect(table.getByRole('button', { name: other.name })).toHaveAttribute('aria-pressed', 'true');
});

it('finishes an in-flight refresh without allowing its older result to undo the rename', async () => {
  const { user, file, other, listDirectory, openRename } = await setup();
  const pending = pausePage<Awaited<ReturnType<StorageBrowserApi['listDirectory']>>>();
  listDirectory.mockReturnValueOnce(pending.promise);
  await user.click(screen.getByRole('button', { name: '刷新目录' }));
  const dialog = await openRename();
  await user.clear(dialog.getByRole('textbox', { name: '名称' }));
  await user.type(dialog.getByRole('textbox', { name: '名称' }), '新名称.txt{Enter}');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '新名称.txt' }).closest('tr')).not.toHaveAttribute(
      'aria-busy',
    ),
  );
  await act(async () => pending.resolve(success({ entries: [file, other] })));
  expect(screen.getByRole('button', { name: '新名称.txt' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('button', { name: file.name })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: other.name })).toBeInTheDocument();
});

it('hides rename for multiple selected entries', async () => {
  const { user, file, other } = await setup();
  await user.click(screen.getByRole('button', { name: file.name }));
  await user.keyboard('{Control>}');
  await user.click(screen.getByRole('button', { name: other.name }));
  await user.keyboard('{/Control}');
  await user.pointer({
    target: screen.getByRole('button', { name: file.name }),
    keys: '[MouseRight]',
  });
  await screen.findByRole('menuitem', { name: '信息' });
  expect(screen.queryByRole('menuitem', { name: '重命名' })).not.toBeInTheDocument();
});

it('cancels an edited name without submitting a rename', async () => {
  const { user, renameEntry, openRename } = await setup();
  const dialog = await openRename();
  await user.clear(dialog.getByRole('textbox', { name: '名称' }));
  await user.type(dialog.getByRole('textbox', { name: '名称' }), '未保存.txt');
  await user.click(dialog.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(renameEntry).not.toHaveBeenCalled();
});

it('runs renames in the background and shows errors in the task queue', async () => {
  const { user, file, renameEntry, openRename } = await setup();
  const pending = pausePage<BrowserResult<Entry>>();
  renameEntry.mockReturnValueOnce(pending.promise);
  const dialog = await openRename();
  const input = dialog.getByRole('textbox', { name: '名称' });
  await user.clear(input);
  await user.type(input, '冲突.txt{Enter}');
  expect(renameEntry).toHaveBeenCalledExactlyOnceWith(file.ref, '冲突.txt');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const toggle = screen.getByRole('button', { name: '任务队列' });
  await user.click(toggle);
  const panel = within(screen.getByRole('region', { name: '任务队列' }));
  expect(panel.getByText('执行中')).toBeInTheDocument();
  expect(panel.getByText('冲突.txt')).toBeInTheDocument();
  await act(async () => pending.resolve({ ok: false, code: 'AlreadyExists' }));
  expect(await panel.findByText('已存在同名项目。')).toBeInTheDocument();
  expect(panel.getByText('失败')).toBeInTheDocument();
  const restored = screen.getByRole('button', { name: file.name });
  expect(restored.closest('tr')).not.toHaveAttribute('data-disabled');
  expect(restored.closest('tr')).not.toHaveAttribute('aria-busy');
  expect(screen.queryByRole('button', { name: '冲突.txt' })).not.toBeInTheDocument();
  const retry = await openRename();
  await user.clear(retry.getByRole('textbox', { name: '名称' }));
  await user.type(retry.getByRole('textbox', { name: '名称' }), '修正.txt');
  await user.click(retry.getByRole('button', { name: '保存' }));
  expect(await screen.findByRole('button', { name: '修正.txt' })).toBeInTheDocument();
  expect(await panel.findByText('已完成')).toBeInTheDocument();
  await user.click(panel.getByRole('button', { name: '清除已结束任务' }));
  expect(panel.getByText('暂无任务')).toBeInTheDocument();
});

it('toggles the floating task panel without rerendering the directory and returns focus to its entry', async () => {
  const { user, file, listDirectory } = await setup();
  const selected = screen.getByRole('button', { name: file.name });
  await user.click(selected);
  const paneRenders = vi.mocked(DirectoryPane).mock.calls.length;
  const tableRenders = vi.mocked(DirectoryTable).mock.calls.length;
  const bar = within(screen.getByRole('contentinfo', { name: '状态栏' }));
  const toggle = bar.getByRole('button', { name: '任务队列' });
  expect(screen.queryByRole('region', { name: '任务队列' })).not.toBeInTheDocument();
  await user.click(toggle);
  const panel = screen.getByRole('region', { name: '任务队列' });
  expect(panel.id).toBe(toggle.getAttribute('aria-controls'));
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(within(panel).getByText('暂无任务')).toBeInTheDocument();
  await user.click(within(panel).getByRole('button', { name: '关闭任务队列' }));
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await user.keyboard('{Enter}');
  expect(screen.getByRole('region', { name: '任务队列' })).toBeVisible();
  await user.click(toggle);
  expect(screen.queryByRole('region', { name: '任务队列' })).not.toBeInTheDocument();
  expect(vi.mocked(DirectoryPane)).toHaveBeenCalledTimes(paneRenders);
  expect(vi.mocked(DirectoryTable)).toHaveBeenCalledTimes(tableRenders);
  expect(listDirectory).toHaveBeenCalledTimes(1);
  expect(selected).toHaveAttribute('aria-pressed', 'true');
});

it('continues a queued rename after switching directories and updates its cached listing', async () => {
  const { user, file, entries, renameEntry, listDirectory, openRename } = await setup();
  const pending = pausePage<BrowserResult<Entry>>();
  renameEntry.mockReturnValueOnce(pending.promise);
  const dialog = await openRename();
  await user.clear(dialog.getByRole('textbox', { name: '名称' }));
  await user.type(dialog.getByRole('textbox', { name: '名称' }), '后台重命名.txt{Enter}');
  await user.click(screen.getByRole('button', { name: '任务队列' }));
  await user.click(screen.getByRole('button', { name: '归档盘' }));
  expect(await screen.findByText('此文件夹为空')).toBeInTheDocument();
  const renamed = { ...file, ref: { ...file.ref, locator: 'renamed' }, name: '后台重命名.txt' };
  entries[0] = renamed;
  await act(async () => pending.resolve(success(renamed)));
  const panel = within(screen.getByRole('region', { name: '任务队列' }));
  expect(await panel.findByText('已完成')).toBeInTheDocument();
  expect(panel.getByText('后台重命名.txt')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '项目盘' }));
  const reopenedFile = await screen.findByRole('button', { name: '后台重命名.txt' });
  expect(screen.queryByRole('button', { name: file.name })).not.toBeInTheDocument();
  expect(listDirectory).toHaveBeenCalledTimes(2);
  await user.pointer({ target: reopenedFile, keys: '[MouseRight]' });
  await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
  const next = within(await screen.findByRole('dialog', { name: '重命名' }));
  await user.clear(next.getByRole('textbox', { name: '名称' }));
  await user.type(next.getByRole('textbox', { name: '名称' }), '再次重命名.txt{Enter}');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '再次重命名.txt' }).closest('tr'),
    ).not.toHaveAttribute('aria-busy'),
  );
  expect(renameEntry).toHaveBeenLastCalledWith(renamed.ref, '再次重命名.txt');
});

it('updates the current location when a folder being browsed finishes renaming', async () => {
  const { user, file, entries, renameEntry, listDirectory, openRename } = await setup('directory');
  listDirectory.mockImplementation(async (parent) =>
    success({ entries: parent.locator === '.' ? entries : [] }),
  );
  const pending = pausePage<BrowserResult<Entry>>();
  renameEntry.mockReturnValueOnce(pending.promise);
  const dialog = await openRename();
  await user.clear(dialog.getByRole('textbox', { name: '名称' }));
  await user.type(dialog.getByRole('textbox', { name: '名称' }), '新文件夹{Enter}');
  await user.dblClick(screen.getByRole('button', { name: '新文件夹' }));
  await screen.findByText('此文件夹为空');
  const renamed = { ...file, ref: { ...file.ref, locator: 'new-folder' }, name: '新文件夹' };
  await act(async () => pending.resolve(success(renamed)));
  const breadcrumbs = within(screen.getByRole('navigation', { name: '当前目录' }));
  expect(await breadcrumbs.findByText('新文件夹')).toHaveAttribute('aria-current', 'page');
  await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(renamed.ref, undefined));
});

it('hides rename when the provider reports that the file cannot be renamed', async () => {
  const { user, file, entries } = await setup();
  entries[0] = { ...file, capabilities: { rename: { support: 'unsupported' } } };
  await user.click(screen.getByRole('button', { name: '刷新目录' }));
  await user.pointer({
    target: screen.getByRole('button', { name: file.name }),
    keys: '[MouseRight]',
  });
  await screen.findByRole('menuitem', { name: '信息' });
  expect(screen.queryByRole('menuitem', { name: '重命名' })).not.toBeInTheDocument();
});

it.each([true, false])(
  'shows the optimistic name and locks writes until success, changed locator: %s',
  async (changedLocator) => {
    const { user, file, other, listDirectory, renameEntry, openRename } = await setup();
    const pending = pausePage<BrowserResult<Entry>>();
    renameEntry.mockReturnValueOnce(pending.promise);
    const dialog = await openRename();
    await user.clear(dialog.getByRole('textbox', { name: '名称' }));
    await user.type(dialog.getByRole('textbox', { name: '名称' }), '提交中的名称.txt{Enter}');
    const optimistic = screen.getByRole('button', { name: '提交中的名称.txt' });
    expect(optimistic.closest('tr')).toHaveAttribute('data-disabled', 'true');
    expect(optimistic.closest('tr')).toHaveAttribute('aria-busy', 'true');
    expect(optimistic).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: other.name }).closest('tr')).not.toHaveAttribute(
      'data-disabled',
    );
    expect(screen.queryByRole('button', { name: file.name })).not.toBeInTheDocument();
    expect(renameEntry).toHaveBeenCalledExactlyOnceWith(file.ref, '提交中的名称.txt');

    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新目录' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '提交中的名称.txt' }).closest('tr')).toHaveAttribute(
      'data-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: '项目盘' }));
    const reopened = await screen.findByRole('button', { name: '提交中的名称.txt' });
    expect(reopened.closest('tr')).toHaveAttribute('data-disabled', 'true');
    await user.click(reopened);
    await user.pointer({ target: reopened, keys: '[MouseRight]' });
    expect(await screen.findByRole('menuitem', { name: '重命名' })).toHaveAttribute(
      'data-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: '信息' })).not.toHaveAttribute('data-disabled');
    await user.keyboard('{Escape}');

    const renamed = {
      ...file,
      ref: { ...file.ref, locator: changedLocator ? 'new-locator' : file.ref.locator },
      name: '提交中的名称.txt',
    };
    await act(async () => pending.resolve(success(renamed)));
    const completed = screen.getByRole('button', { name: renamed.name });
    expect(completed.closest('tr')).not.toHaveAttribute('data-disabled');
    expect(completed.closest('tr')).not.toHaveAttribute('aria-busy');
    expect(completed).toHaveAttribute('aria-pressed', 'true');
    expect(listDirectory).toHaveBeenCalledTimes(2);
    await user.pointer({ target: completed, keys: '[MouseRight]' });
    expect(await screen.findByRole('menuitem', { name: '重命名' })).not.toHaveAttribute(
      'data-disabled',
    );
  },
);

it('optimistically renames and locks waiting tasks before they begin execution', async () => {
  const { user, file, other, renameEntry, openRename } = await setup();
  const first = pausePage<BrowserResult<Entry>>();
  const second = pausePage<BrowserResult<Entry>>();
  renameEntry.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const dialog = await openRename();
  await user.clear(dialog.getByRole('textbox', { name: '名称' }));
  await user.type(dialog.getByRole('textbox', { name: '名称' }), '第一个任务.txt{Enter}');
  await user.pointer({
    target: screen.getByRole('button', { name: other.name }),
    keys: '[MouseRight]',
  });
  await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
  const next = within(await screen.findByRole('dialog', { name: '重命名' }));
  await user.clear(next.getByRole('textbox', { name: '名称' }));
  await user.type(next.getByRole('textbox', { name: '名称' }), '第二个任务.txt{Enter}');
  expect(screen.getByRole('button', { name: '第一个任务.txt' }).closest('tr')).toHaveAttribute(
    'data-disabled',
    'true',
  );
  expect(screen.getByRole('button', { name: '第二个任务.txt' }).closest('tr')).toHaveAttribute(
    'data-disabled',
    'true',
  );
  expect(renameEntry).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(success({ ...file, name: '第一个任务.txt' })));
  expect(renameEntry).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '第一个任务.txt' }).closest('tr')).not.toHaveAttribute(
    'data-disabled',
  );
  expect(screen.getByRole('button', { name: '第二个任务.txt' }).closest('tr')).toHaveAttribute(
    'data-disabled',
    'true',
  );
  await act(async () => second.resolve(success({ ...other, name: '第二个任务.txt' })));
  expect(screen.getByRole('button', { name: '第二个任务.txt' }).closest('tr')).not.toHaveAttribute(
    'data-disabled',
  );
});
