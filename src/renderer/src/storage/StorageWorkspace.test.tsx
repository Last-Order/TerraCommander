import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { SWRConfig } from 'swr';
import { expect, it, vi } from 'vitest';
import type { Space } from '../../../shared/storage';
import {
  localConnectionId,
  type BrowserResult,
  type StorageBrowserApi,
  type StorageConnectionSummary,
} from '../../../shared/storage-browser';
import { App } from '../app/App';

function success<T>(value: T): BrowserResult<T> {
  return { ok: true, value };
}

function renderWorkspace() {
  render(
    <StrictMode>
      <SWRConfig value={{ provider: () => new Map() }}>
        <App />
      </SWRConfig>
    </StrictMode>,
  );
}

it('adds a local folder to the same sidebar as Drive and browses both connections', async () => {
  const user = userEvent.setup();
  const local: Space = {
    id: 'saved-folder',
    connectionId: localConnectionId,
    name: '项目文件夹',
    root: { connectionId: localConnectionId, spaceId: 'saved-folder', locator: '.' },
  };
  const drive: Space = {
    id: 'my-drive',
    connectionId: 'studio',
    name: '我的云端硬盘',
    root: { connectionId: 'studio', spaceId: 'my-drive', locator: 'root' },
  };
  const google: StorageConnectionSummary = {
    id: 'studio',
    provider: 'google-drive',
    name: '工作室',
    needsAuthorization: false,
    spaces: [drive],
  };
  let visible: Space[] | undefined;
  const storage: StorageBrowserApi = {
    async listConnections() {
      return success(
        visible
          ? [
              google,
              {
                id: localConnectionId,
                provider: 'local',
                name: '此电脑',
                needsAuthorization: false,
                spaces: visible,
              },
            ]
          : [google],
      );
    },
    async listSpaces() {
      return success((visible ?? []).map((space) => ({ space, available: true })));
    },
    async saveSpaces(id, ids) {
      expect(id).toBe(localConnectionId);
      visible = ids.includes(local.id) ? [local] : [];
      return success(undefined);
    },
    async chooseFolder() {
      return success(local);
    },
    async addGoogleDrive() {
      return success(google);
    },
    async reauthorize() {
      return success(undefined);
    },
    async cancelAuthorization() {
      return success(undefined);
    },
    async listDirectory(ref) {
      const name = ref.connectionId === localConnectionId ? '本地文件.txt' : '云端文件.txt';
      return success({
        entries: [{ ref: { ...ref, locator: 'file' }, name, kind: 'file', capabilities: {} }],
      });
    },
  };

  const listConnections = vi.spyOn(storage, 'listConnections');
  const listSpaces = vi.spyOn(storage, 'listSpaces');
  vi.stubGlobal('desktop', { storage });
  try {
    renderWorkspace();
    const navigation = screen.getByRole('navigation', { name: '存储' });
    const driveLink = await within(navigation).findByRole('button', { name: drive.name });
    expect(listConnections).toHaveBeenCalledTimes(1);
    await user.click(driveLink);
    expect(await screen.findByText('云端文件.txt')).toBeInTheDocument();

    await user.click(within(navigation).getByRole('button', { name: '添加存储' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '本地文件系统' }));
    await user.click(within(dialog).getByRole('button', { name: '选择文件夹' }));
    expect(listSpaces).toHaveBeenCalledExactlyOnceWith(localConnectionId);
    expect(within(dialog).getByRole('checkbox', { name: local.name })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const localLink = await within(navigation).findByRole('button', { name: local.name });
    await user.click(localLink);
    expect(await screen.findByText('本地文件.txt')).toBeInTheDocument();
    expect(localLink).toHaveAttribute('aria-current', 'location');
    expect(driveLink).toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('loads only the next directory page and refreshes the visible pages with the new cursor', async () => {
  const user = userEvent.setup();
  const space: Space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  };
  const connections: StorageConnectionSummary[] = [
    {
      id: localConnectionId,
      provider: 'local',
      name: '此电脑',
      needsAuthorization: false,
      spaces: [space],
    },
  ];
  let revision = 'before';
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (ref, cursor) => {
    if (cursor) expect(cursor).toBe(revision);
    const locator = cursor ? 'second' : 'first';
    return success({
      entries: [
        {
          ref: { ...ref, locator },
          name: `${locator}-${revision}`,
          kind: 'file',
          capabilities: {},
        },
      ],
      ...(cursor ? {} : { nextCursor: revision }),
    });
  });

  vi.stubGlobal('desktop', {
    storage: { listConnections: async () => success(connections), listDirectory },
  });
  try {
    renderWorkspace();
    await user.click(await screen.findByRole('button', { name: space.name }));
    expect(await screen.findByText('first-before')).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledExactlyOnceWith(space.root, undefined);

    await user.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('second-before')).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory).toHaveBeenLastCalledWith(space.root, 'before');

    revision = 'after';
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    expect(await screen.findByText('second-after')).toBeInTheDocument();
    expect(screen.getByText('first-after')).toBeInTheDocument();
    expect(listDirectory.mock.calls.slice(2)).toEqual([
      [space.root, undefined],
      [space.root, 'after'],
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
