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

async function setup() {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const folder: Entry = {
    ref: { ...space.root, locator: 'folder' },
    name: '资料',
    kind: 'directory',
    capabilities: {},
  };
  const file: Entry = {
    ref: { ...space.root, locator: 'file' },
    name: '清单.txt',
    kind: 'file',
    capabilities: {},
  };
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (ref) =>
    success({ entries: ref.locator === space.root.locator ? [folder, file] : [] }),
  );
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () => success([{ ...emptyLocalConnection, spaces: [space] }]),
      listDirectory,
    },
  });
  await renderWorkspace();
  const spaceButton = await screen.findByRole('button', { name: space.name });
  return { user, space, folder, file, listDirectory, spaceButton };
}

function pressF5(init: KeyboardEventInit = {}, target: Element | Window = window) {
  const event = new KeyboardEvent('keydown', {
    key: 'F5',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  fireEvent(target, event);
  return event;
}

it('refreshes with F5 from the sidebar or file list and preserves selection', async () => {
  const { user, file, space, spaceButton, listDirectory } = await setup();
  expect(pressF5().defaultPrevented).toBe(false);
  await user.click(spaceButton);
  await screen.findByRole('button', { name: file.name });
  expect(spaceButton).toHaveFocus();
  expect(pressF5({}, spaceButton).defaultPrevented).toBe(true);
  await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新目录' })).toBeEnabled());

  const selected = screen.getByRole('button', { name: file.name });
  await user.click(selected);
  listDirectory.mockResolvedValueOnce(success({ entries: [{ ...file, name: '更新的清单.txt' }] }));
  expect(pressF5({}, selected).defaultPrevented).toBe(true);
  expect(await screen.findByRole('button', { name: '更新的清单.txt' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(listDirectory.mock.calls).toEqual(
    Array.from({ length: 3 }, () => [space.root, undefined]),
  );
  expect(screen.getByRole('button', { name: '刷新目录' })).toHaveAttribute(
    'aria-keyshortcuts',
    'F5',
  );
});

it('reserves F5 during loading and ignores key repeats and modified F5', async () => {
  const { user, file, spaceButton, listDirectory } = await setup();
  const pending = pausePage<Awaited<ReturnType<StorageBrowserApi['listDirectory']>>>();
  listDirectory.mockReturnValueOnce(pending.promise);
  try {
    await user.click(spaceButton);
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
    expect(pressF5().defaultPrevented).toBe(true);
    expect(listDirectory).toHaveBeenCalledTimes(1);
    pending.resolve(success({ entries: [file] }));
    await screen.findByRole('button', { name: file.name });

    expect(pressF5({ repeat: true }).defaultPrevented).toBe(true);
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
      expect(pressF5({ [modifier]: true }).defaultPrevented).toBe(false);
    }
    expect(listDirectory).toHaveBeenCalledTimes(1);

    const refreshing = pausePage<Awaited<ReturnType<StorageBrowserApi['listDirectory']>>>();
    listDirectory.mockReturnValueOnce(refreshing.promise);
    pressF5();
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));
    expect(pressF5().defaultPrevented).toBe(true);
    expect(listDirectory).toHaveBeenCalledTimes(2);
    refreshing.resolve(success({ entries: [] }));
    await screen.findByText('此文件夹为空');
  } finally {
    pending.resolve(success({ entries: [] }));
  }
});

it('refreshes the current empty directory after navigation and retries failed listings', async () => {
  const { user, folder, spaceButton, listDirectory } = await setup();
  await user.click(spaceButton);
  await user.dblClick(await screen.findByRole('button', { name: folder.name }));
  await screen.findByText('此文件夹为空');
  listDirectory.mockResolvedValueOnce({ ok: false, code: 'NetworkError' });
  pressF5();
  await screen.findByRole('alert');
  expect(listDirectory).toHaveBeenCalledTimes(3);
  expect(listDirectory).toHaveBeenLastCalledWith(folder.ref, undefined);

  pressF5();
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(listDirectory).toHaveBeenCalledTimes(4);
  expect(listDirectory).toHaveBeenLastCalledWith(folder.ref, undefined);
});

it('reserves F5 without refreshing behind a modal, then resumes after it closes', async () => {
  const { user, file, spaceButton, listDirectory } = await setup();
  await user.click(spaceButton);
  const entry = await screen.findByRole('button', { name: file.name });
  await user.pointer({ target: entry, keys: '[MouseRight]' });
  await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
  const rename = within(await screen.findByRole('dialog', { name: '重命名' }));
  const input = rename.getByRole('textbox', { name: '名称' });
  expect(pressF5({}, input).defaultPrevented).toBe(true);
  const cancel = rename.getByRole('button', { name: '取消' });
  await user.click(cancel);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(listDirectory).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole('button', { name: '设置' }));
  const settings = within(await screen.findByRole('dialog', { name: '设置' }));
  const close = settings.getByRole('button', { name: '关闭' });
  expect(pressF5({}, close).defaultPrevented).toBe(true);
  expect(listDirectory).toHaveBeenCalledTimes(1);
  await user.click(close);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  pressF5();
  await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));
});
