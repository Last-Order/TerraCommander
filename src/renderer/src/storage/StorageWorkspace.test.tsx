import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { EntryPage, Space } from '../../../shared/storage';
import {
  emptyLocalConnection,
  localConnectionId,
  type BrowserResult,
  type StorageBrowserApi,
  type StorageConnectionSummary,
} from '../../../shared/storage-browser';
import { renderWorkspace } from '../testing/render-app';
import { pausePage, success } from '../testing/storage-browser-fixtures';

it('adds a local folder to the same sidebar as Drive and browses both connections', async () => {
  const user = userEvent.setup();
  const local = {
    id: 'saved-folder',
    connectionId: localConnectionId,
    name: '项目文件夹',
    root: { connectionId: localConnectionId, spaceId: 'saved-folder', locator: '.' },
  } satisfies Space;
  const drive: Space = {
    id: 'my-drive',
    connectionId: 'studio',
    name: { messageKey: 'myDrive' },
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
    async deleteEntry() {
      return { ok: false, code: 'Unsupported' };
    },
    async renameEntry() {
      return { ok: false, code: 'Unsupported' };
    },
    async listConnections() {
      return success(
        visible
          ? [
              google,
              {
                ...emptyLocalConnection,
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
    async measureDirectorySize() {
      return success(null);
    },
    async cancelDirectoryMeasurement() {
      return success(undefined);
    },
  };

  const listConnections = vi.spyOn(storage, 'listConnections');
  const listSpaces = vi.spyOn(storage, 'listSpaces');
  vi.stubGlobal('desktop', { storage });
  try {
    await renderWorkspace();
    const navigation = screen.getByRole('navigation', { name: '存储' });
    const driveLink = await within(navigation).findByRole('button', { name: '我的云端硬盘' });
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

it('reuses directory pages when switching storage spaces and refreshes with the new cursor', async () => {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const otherSpace = {
    id: 'other',
    connectionId: localConnectionId,
    name: '备用盘',
    root: { connectionId: localConnectionId, spaceId: 'other', locator: '.' },
  } satisfies Space;
  const connections: StorageConnectionSummary[] = [
    {
      ...emptyLocalConnection,
      spaces: [space, otherSpace],
    },
  ];
  let revision = 'before';
  const abandonedRefresh = pausePage<BrowserResult<EntryPage>>();
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (ref, cursor) => {
    if (ref.spaceId === otherSpace.id) return success({ entries: [] });
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
    await renderWorkspace();
    const drive = await screen.findByRole('button', { name: space.name });
    const otherDrive = screen.getByRole('button', { name: otherSpace.name });
    await user.click(drive);
    expect(await screen.findByText('second-before')).toBeInTheDocument();
    expect(screen.getByText('first-before')).toBeInTheDocument();
    expect(listDirectory.mock.calls).toEqual([
      [space.root, undefined],
      [space.root, 'before'],
    ]);

    revision = 'after';
    await user.click(otherDrive);
    expect(await screen.findByText('此文件夹为空')).toBeInTheDocument();
    expect(screen.queryByText('first-before')).not.toBeInTheDocument();
    await user.click(drive);
    expect(screen.getByText('first-before')).toBeInTheDocument();
    expect(screen.getByText('second-before')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(listDirectory.mock.calls.slice(2)).toEqual([[otherSpace.root, undefined]]);

    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    expect(await screen.findByText('second-after')).toBeInTheDocument();
    expect(screen.getByText('first-after')).toBeInTheDocument();
    expect(listDirectory.mock.calls.slice(3)).toEqual([
      [space.root, undefined],
      [space.root, 'after'],
    ]);

    await user.click(otherDrive);
    expect(screen.getByText('此文件夹为空')).toBeInTheDocument();
    await user.click(drive);
    expect(screen.getByText('first-after')).toBeInTheDocument();
    expect(screen.getByText('second-after')).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledTimes(5);

    listDirectory.mockReturnValueOnce(abandonedRefresh.promise);
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    await user.click(otherDrive);
    await act(async () => {
      abandonedRefresh.resolve(success({ entries: [], nextCursor: 'abandoned' }));
      await abandonedRefresh.promise;
    });
    expect(screen.getByText('此文件夹为空')).toBeInTheDocument();
    await user.click(drive);
    expect(screen.getByText('second-after')).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledTimes(6);
  } finally {
    abandonedRefresh.resolve(success({ entries: [] }));
    vi.unstubAllGlobals();
  }
});

it('invalidates the authorized connection cache while another storage space is open', async () => {
  const user = userEvent.setup();
  const local = {
    id: 'local-drive',
    connectionId: localConnectionId,
    name: '本地盘',
    root: { connectionId: localConnectionId, spaceId: 'local-drive', locator: '.' },
  } satisfies Space;
  const drive = {
    id: 'my-drive',
    connectionId: 'studio',
    name: '云端盘',
    root: { connectionId: 'studio', spaceId: 'my-drive', locator: 'root' },
  } satisfies Space;
  const child = { ...drive.root, locator: 'child' };
  let needsAuthorization = false;
  let folderName = '原有资料';
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (ref) => {
    if (ref.connectionId === localConnectionId) return success({ entries: [] });
    if (ref.locator === child.locator) {
      needsAuthorization = true;
      return { ok: false, code: 'AuthRequired' };
    }
    return success({
      entries: [{ ref: child, name: folderName, kind: 'directory', capabilities: {} }],
    });
  });
  const reauthorize = vi.fn<StorageBrowserApi['reauthorize']>(async () => {
    needsAuthorization = false;
    folderName = '更新后的资料';
    return success(undefined);
  });
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () =>
        success([
          { ...emptyLocalConnection, spaces: [local] },
          {
            id: drive.connectionId,
            provider: 'google-drive',
            name: '工作室',
            needsAuthorization,
            spaces: [drive],
          },
        ]),
      listDirectory,
      reauthorize,
    },
  });
  try {
    await renderWorkspace();
    const cloudLink = await screen.findByRole('button', { name: drive.name });
    const localLink = screen.getByRole('button', { name: local.name });
    await user.click(cloudLink);
    await user.dblClick(await screen.findByRole('button', { name: folderName }));
    const authorizeLink = await screen.findByRole('button', { name: '重新授权' });
    expect(cloudLink).toBeDisabled();
    expect(localLink).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: '管理 工作室 显示的空间' }),
    ).not.toBeInTheDocument();
    await user.click(localLink);
    await screen.findByText('此文件夹为空');
    await user.click(cloudLink);
    expect(screen.getByText('此文件夹为空')).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledTimes(3);

    await user.click(authorizeLink);
    let dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('“工作室” 的授权已失效，是否重新授权？')).toBeInTheDocument();
    expect(reauthorize).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(reauthorize).not.toHaveBeenCalled();
    await user.click(authorizeLink);
    dialog = within(screen.getByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: '重新授权' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(reauthorize).toHaveBeenCalledExactlyOnceWith(drive.connectionId);
    expect(
      await screen.findByRole('button', { name: '管理 工作室 显示的空间' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新授权' })).not.toBeInTheDocument();
    expect(cloudLink).toBeEnabled();

    await user.click(cloudLink);
    expect(await screen.findByRole('button', { name: '更新后的资料' })).toBeInTheDocument();
    await user.click(localLink);
    expect(screen.getByText('此文件夹为空')).toBeInTheDocument();
    expect(listDirectory.mock.calls).toEqual([
      [drive.root, undefined],
      [child, undefined],
      [local.root, undefined],
      [drive.root, undefined],
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('ignores a late directory page after reauthorizing the active connection', async () => {
  const user = userEvent.setup();
  const drive = {
    id: 'my-drive',
    connectionId: 'studio',
    name: '云端盘',
    root: { connectionId: 'studio', spaceId: 'my-drive', locator: 'root' },
  } satisfies Space;
  const stale = {
    ref: { ...drive.root, locator: 'file' },
    name: '旧资料',
    kind: 'file',
    capabilities: {},
  } as const;
  const fresh = { ...stale, name: '已授权资料' };
  const oldRequest = pausePage<BrowserResult<EntryPage>>();
  const listDirectory = vi
    .fn<StorageBrowserApi['listDirectory']>()
    .mockReturnValueOnce(oldRequest.promise)
    .mockResolvedValue(success({ entries: [fresh] }));
  let needsAuthorization = false;
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () =>
        success([
          {
            id: drive.connectionId,
            provider: 'google-drive',
            name: '工作室',
            needsAuthorization,
            spaces: [drive],
          },
        ]),
      listDirectory,
      listSpaces: async () => {
        needsAuthorization = true;
        return { ok: false, code: 'AuthRequired' };
      },
      reauthorize: async () => {
        needsAuthorization = false;
        return success(undefined);
      },
    },
  });
  try {
    await renderWorkspace();
    const cloudLink = await screen.findByRole('button', { name: drive.name });
    await user.click(cloudLink);
    expect(listDirectory).toHaveBeenCalledExactlyOnceWith(drive.root, undefined);

    await user.click(screen.getByRole('button', { name: '管理 工作室 显示的空间' }));
    const picker = within(screen.getByRole('dialog'));
    await picker.findByRole('alert');
    await user.click(picker.getByRole('button', { name: '取消' }));
    const authorizeLink = await screen.findByRole('button', { name: '重新授权' });
    expect(cloudLink).toBeDisabled();
    await user.click(authorizeLink);
    const dialog = within(screen.getByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: '重新授权' }));
    expect(await screen.findByRole('button', { name: fresh.name })).toBeInTheDocument();

    await act(async () => {
      oldRequest.resolve(success({ entries: [stale], nextCursor: 'old-next' }));
      await oldRequest.promise;
    });
    expect(screen.queryByRole('button', { name: stale.name })).not.toBeInTheDocument();
    await user.click(cloudLink);
    expect(screen.getByRole('button', { name: fresh.name })).toBeInTheDocument();
    expect(listDirectory.mock.calls).toEqual([
      [drive.root, undefined],
      [drive.root, undefined],
    ]);
  } finally {
    oldRequest.resolve(success({ entries: [] }));
    vi.unstubAllGlobals();
  }
});
