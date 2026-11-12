import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Entry, Space } from '../../../../shared/storage';
import {
  emptyLocalConnection,
  localConnectionId,
  type StorageBrowserApi,
} from '../../../../shared/storage-browser';
import { renderWorkspace } from '../../testing/render-app';
import { success } from '../../testing/storage-browser-fixtures';

afterEach(() => vi.unstubAllGlobals());

async function setup(order = [1, 2, 3, 4, 5]) {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const entries = order.map((index): Entry => ({
    ref: { ...space.root, locator: String(index) },
    name: `item${index}`,
    kind: index === 5 ? 'directory' : 'file',
    size: index,
    capabilities: {},
  }));
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
  await user.click(await screen.findByRole('button', { name: space.name }));
  const table = within(await screen.findByRole('table', { name: '文件和文件夹' }));
  await table.findByRole('button', { name: '名称' });
  const item = (index: number) => table.getByRole('button', { name: `item${index}` });
  const selectedNames = () =>
    table.getAllByRole('button', { pressed: true }).map((button) => button.textContent);
  return { user, table, item, selectedNames, entries, listDirectory };
}

it('keeps the Shift anchor while extending, shrinking and reversing a range', async () => {
  const { user, item, selectedNames, listDirectory } = await setup();
  await user.keyboard('{Shift>}');
  await user.click(item(3));
  expect(selectedNames()).toEqual(['item3']);
  await user.click(item(5));
  expect(selectedNames()).toEqual(['item3', 'item4', 'item5']);
  await user.click(item(4));
  expect(selectedNames()).toEqual(['item3', 'item4']);
  await user.click(item(1));
  expect(selectedNames()).toEqual(['item1', 'item2', 'item3']);
  await user.dblClick(item(5));
  expect(selectedNames()).toEqual(['item3', 'item4', 'item5']);
  expect(listDirectory).toHaveBeenCalledTimes(1);
  await user.keyboard('{/Shift}');
  await user.click(item(2));
  expect(selectedNames()).toEqual(['item2']);
});

it('appends ranges with Ctrl+Shift and keeps Ctrl toggling individual entries', async () => {
  const { user, item, selectedNames } = await setup();
  await user.click(item(1));
  await user.keyboard('{Control>}');
  await user.click(item(3));
  expect(selectedNames()).toEqual(['item1', 'item3']);
  await user.keyboard('{Shift>}');
  await user.click(item(5));
  expect(selectedNames()).toEqual(['item1', 'item3', 'item4', 'item5']);
  await user.keyboard('{/Shift}');
  await user.click(item(3));
  expect(selectedNames()).toEqual(['item1', 'item4', 'item5']);
  await user.keyboard('{/Control}{Shift>}');
  await user.click(item(2));
  expect(selectedNames()).toEqual(['item2', 'item3']);
  await user.keyboard('{/Shift}');
});

it('calculates ranges in the displayed sort order and retains the anchor after sorting', async () => {
  const { user, table, item, selectedNames } = await setup([4, 1, 5, 2, 3]);
  await user.click(item(4));
  const name = table.getByRole('button', { name: '名称' });
  await user.click(name);
  await user.keyboard('{Shift>}');
  await user.click(item(2));
  expect(selectedNames()).toEqual(['item2', 'item3', 'item4']);
  await user.keyboard('{/Shift}');
  await user.click(name);
  await user.keyboard('{Shift>}');
  await user.click(item(2));
  expect(selectedNames()).toEqual(['item4', 'item3', 'item2']);
  await user.click(item(5));
  expect(selectedNames()).toEqual(['item5', 'item4']);
  await user.keyboard('{/Shift}');
});

it('selects the full listing with Ctrl+A after clicking a cell and scopes the shortcut to the table', async () => {
  const { user, table, item, selectedNames } = await setup();
  const size = within(table.getByRole('row', { name: /item3/ })).getByRole('cell', { name: '3 B' });
  await user.click(size);
  expect(item(3)).toHaveFocus();
  await user.keyboard('{Control>}a{/Control}');
  expect(selectedNames()).toEqual(['item1', 'item2', 'item3', 'item4', 'item5']);
  await user.keyboard('{Shift>}');
  await user.click(item(4));
  expect(selectedNames()).toEqual(['item3', 'item4']);
  await user.keyboard('{/Shift}');
  await user.click(item(1));
  const refresh = screen.getByRole('button', { name: '刷新目录' });
  act(() => refresh.focus());
  expect(fireEvent.keyDown(refresh, { key: 'a', ctrlKey: true })).toBe(true);
  expect(selectedNames()).toEqual(['item1']);
});

it('clears a removed anchor even if that entry reappears in a later refresh', async () => {
  const { user, item, selectedNames, entries, listDirectory } = await setup();
  await user.click(item(2));
  listDirectory.mockResolvedValueOnce(
    success({ entries: entries.filter((entry) => entry.ref.locator !== '2') }),
  );
  const refresh = screen.getByRole('button', { name: '刷新目录' });
  await user.click(refresh);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'item2' })).not.toBeInTheDocument(),
  );
  await user.click(refresh);
  await screen.findByRole('button', { name: 'item2' });
  await user.keyboard('{Shift>}');
  await user.click(item(4));
  expect(selectedNames()).toEqual(['item4']);
  await user.keyboard('{/Shift}');
});
