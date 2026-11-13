import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Entry, Space } from '../../../../shared/storage';
import {
  emptyLocalConnection,
  localConnectionId,
  type StorageBrowserApi,
} from '../../../../shared/storage-browser';
import { renderWorkspace } from '../../testing/render-app';
import { pausePage, success } from '../../testing/storage-browser-fixtures';

afterEach(() => vi.unstubAllGlobals());

async function setup(open = true) {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const entries = ['Report.TXT', 'notes.txt', 'report-final.md', 'a.*[1].txt', '资料'].map(
    (name, index): Entry => ({
      ref: { ...space.root, locator: String(index) },
      name,
      kind: name === '资料' ? 'directory' : 'file',
      capabilities: {},
    }),
  );
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (parent) =>
    success({ entries: parent.locator === '.' ? entries : [] }),
  );
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () => success([{ ...emptyLocalConnection, spaces: [space] }]),
      listDirectory,
    },
  });
  await renderWorkspace();
  const spaceButton = await screen.findByRole('button', { name: space.name });
  if (open) {
    await user.click(spaceButton);
    await screen.findByRole('button', { name: 'Report.TXT' });
  }
  const find = async () => {
    fireEvent.keyDown(document.activeElement ?? window, { key: 'f', ctrlKey: true });
    return screen.findByRole('searchbox', { name: '搜索当前目录' });
  };
  const table = () => within(screen.getByRole('table', { name: '文件和文件夹' }));
  const selectedNames = () =>
    table()
      .queryAllByRole('button', { pressed: true })
      .map((button) => button.textContent);
  const position = () => screen.getByRole('status');
  return { user, spaceButton, entries, listDirectory, find, table, selectedNames, position };
}

it('opens with Ctrl+F and selects the first match without filtering the directory', async () => {
  const { user, find, table, selectedNames, position, listDirectory } = await setup();
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  const input = await find();
  expect(input).toHaveFocus();
  expect(screen.queryByRole('button', { name: '下一个匹配项' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '上一个匹配项' })).not.toBeInTheDocument();
  await user.type(input, 'REPORT');
  expect(table().getAllByRole('row')).toHaveLength(6);
  expect(selectedNames()).toEqual(['Report.TXT']);
  expect(position()).toHaveTextContent('1 / 2');
  expect(position()).toHaveAccessibleName('第 1 个匹配项，共 2 个');
  expect(await find()).toHaveFocus();
  expect(input).toHaveProperty('selectionStart', 0);
  expect(input).toHaveProperty('selectionEnd', 6);

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '刷新目录' })).toHaveFocus();
  expect(selectedNames()).toEqual(['Report.TXT']);
  const reopened = await find();
  expect(reopened).toHaveFocus();
  await user.type(reopened, 'notes');
  expect(selectedNames()).toEqual(['notes.txt']);
  await user.click(screen.getByRole('button', { name: '关闭搜索' }));
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(selectedNames()).toEqual(['notes.txt']);
  expect(listDirectory).toHaveBeenCalledTimes(1);
});

it('navigates both ways with buttons and Enter, wraps around, and keeps the input focused', async () => {
  const { user, find, selectedNames, position } = await setup();
  await user.click(screen.getByRole('button', { name: 'notes.txt' }));
  const input = await find();
  await user.type(input, 'report');
  expect(selectedNames()).toEqual(['Report.TXT']);
  const next = screen.getByRole('button', { name: '下一个匹配项' });
  const previous = screen.getByRole('button', { name: '上一个匹配项' });
  await user.click(next);
  expect(selectedNames()).toEqual(['report-final.md']);
  expect(position()).toHaveTextContent('2 / 2');
  expect(input).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(selectedNames()).toEqual(['Report.TXT']);
  expect(position()).toHaveTextContent('1 / 2');
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  expect(selectedNames()).toEqual(['report-final.md']);
  await user.click(previous);
  expect(selectedNames()).toEqual(['Report.TXT']);
  await user.click(previous);
  expect(selectedNames()).toEqual(['report-final.md']);
  expect(input).toHaveFocus();
});

it('matches punctuation, Chinese and whitespace literally and shows no results instead of navigation', async () => {
  const { user, find, selectedNames, position, table, listDirectory } = await setup();
  const input = await find();
  await user.type(input, '.*');
  expect(selectedNames()).toEqual(['a.*[1].txt']);
  expect(position()).toHaveTextContent('1 / 1');
  await user.keyboard('{Enter}');
  expect(selectedNames()).toEqual(['a.*[1].txt']);
  await user.clear(input);
  await user.type(input, '资');
  expect(selectedNames()).toEqual(['资料']);
  await user.clear(input);
  await user.type(input, ' report');
  expect(selectedNames()).toEqual([]);
  expect(position()).toHaveTextContent('无结果');
  expect(position()).toHaveAccessibleName('无结果');
  expect(table().getAllByRole('row')).toHaveLength(6);
  expect(screen.queryByRole('button', { name: '下一个匹配项' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '上一个匹配项' })).not.toBeInTheDocument();
  await user.keyboard('{Enter}{Shift>}{Enter}{/Shift}');
  expect(selectedNames()).toEqual([]);
  await user.clear(input);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '下一个匹配项' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '上一个匹配项' })).not.toBeInTheDocument();
  expect(listDirectory).toHaveBeenCalledTimes(1);
});

it('uses the displayed sort order and retains the current match when sorting or refreshing', async () => {
  const { user, find, table, selectedNames, position, entries, listDirectory } = await setup();
  await user.type(await find(), 'report');
  await user.click(table().getByRole('button', { name: '名称' }));
  expect(selectedNames()).toEqual(['Report.TXT']);
  expect(position()).toHaveTextContent('2 / 2');
  await user.click(screen.getByRole('button', { name: '下一个匹配项' }));
  expect(selectedNames()).toEqual(['report-final.md']);
  expect(position()).toHaveTextContent('1 / 2');
  fireEvent.keyDown(await find(), { key: 'F5' });
  await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新目录' })).toBeEnabled());
  expect(selectedNames()).toEqual(['report-final.md']);
  listDirectory.mockResolvedValueOnce(
    success({ entries: entries.filter(({ name }) => name !== 'report-final.md') }),
  );
  fireEvent.keyDown(await find(), { key: 'F5' });
  await waitFor(() => expect(position()).toHaveTextContent('1 / 1'));
  expect(selectedNames()).toEqual(['Report.TXT']);
});

it('adds paginated matches without losing the current match and resets on folder navigation', async () => {
  const { user, spaceButton, entries, listDirectory, find, selectedNames, position } =
    await setup(false);
  const nextPage = pausePage<Awaited<ReturnType<StorageBrowserApi['listDirectory']>>>();
  listDirectory
    .mockResolvedValueOnce(success({ entries: entries.slice(0, 2), nextCursor: 'next' }))
    .mockReturnValueOnce(nextPage.promise);
  try {
    await user.click(spaceButton);
    await screen.findByRole('button', { name: 'Report.TXT' });
    const input = await find();
    await user.type(input, 'report');
    expect(position()).toHaveTextContent('1 / 1');
    nextPage.resolve(success({ entries: entries.slice(2) }));
    await waitFor(() => expect(position()).toHaveTextContent('1 / 2'));
    expect(selectedNames()).toEqual(['Report.TXT']);
    await user.keyboard('{Enter}');
    expect(selectedNames()).toEqual(['report-final.md']);
    await user.clear(input);
    await user.type(input, '资料');
    await user.dblClick(screen.getByRole('button', { name: '资料' }));
    await screen.findByText('此文件夹为空');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledTimes(3);
  } finally {
    nextPage.resolve(success({ entries: [] }));
  }
});

it('ignores composition and modified keys and does not navigate behind a modal', async () => {
  const { user, find, selectedNames, position } = await setup();
  const input = await find();
  await user.type(input, 'report');
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'isComposing']) {
    fireEvent.keyDown(input, { key: 'Enter', [modifier]: true });
  }
  expect(selectedNames()).toEqual(['Report.TXT']);
  await user.click(screen.getByRole('button', { name: '设置' }));
  const dialog = within(await screen.findByRole('dialog', { name: '设置' }));
  expect(
    fireEvent.keyDown(dialog.getByRole('button', { name: '关闭' }), { key: 'f', ctrlKey: true }),
  ).toBe(false);
  await user.click(dialog.getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(position()).toHaveTextContent('1 / 2');
  expect(selectedNames()).toEqual(['Report.TXT']);
});
