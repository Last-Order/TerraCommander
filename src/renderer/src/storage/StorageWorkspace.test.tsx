import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { SWRConfig } from 'swr';
import { expect, it, vi } from 'vitest';
import type { Space } from '../../../shared/storage';
import {
  emptyLocalConnection,
  localConnectionId,
  type BrowserResult,
  type StorageBrowserApi,
  type StorageConnectionSummary,
} from '../../../shared/storage-browser';
import { App } from '../app/App';
import { createRendererI18n } from '../i18n/i18n';

function success<T>(value: T): BrowserResult<T> {
  return { ok: true, value };
}

async function renderWorkspace() {
  const i18n = await createRendererI18n('zh-CN');
  render(
    <StrictMode>
      <SWRConfig value={{ provider: () => new Map() }}>
        <I18nextProvider i18n={i18n}>
          <App languagePreference="system" />
        </I18nextProvider>
      </SWRConfig>
    </StrictMode>,
  );
}

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

it('shows file details and supports selection and opening from the whole row', async () => {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const child = { ...space.root, locator: 'child' };
  const modifiedAt = '2026-01-02T03:04:06.000Z';
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (ref) =>
    success({
      entries:
        ref.locator === space.root.locator
          ? [
              { ref: child, name: '资料', kind: 'directory', modifiedAt, capabilities: {} },
              {
                ref: { ...ref, locator: 'file' },
                name: '清单.txt',
                kind: 'file',
                size: 1536,
                modifiedAt,
                capabilities: {},
              },
              {
                ref: { ...ref, locator: 'empty-file' },
                name: '空文件.txt',
                kind: 'file',
                size: 0,
                capabilities: {},
              },
            ]
          : [],
    }),
  );
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () => success([{ ...emptyLocalConnection, spaces: [space] }]),
      listDirectory,
    },
  });
  try {
    await renderWorkspace();
    await user.click(await screen.findByRole('button', { name: space.name }));
    const table = within(await screen.findByRole('table', { name: '文件和文件夹' }));
    expect(table.getByRole('columnheader', { name: '修改时间' })).toBeInTheDocument();
    expect(table.getByRole('columnheader', { name: '大小' })).toBeInTheDocument();
    const folderRow = within(table.getByRole('row', { name: /资料/ }));
    const fileRow = within(table.getByRole('row', { name: /清单\.txt/ }));
    const emptyFile = within(table.getByRole('row', { name: /空文件\.txt/ }));
    const folder = folderRow.getByRole('button', { name: '资料' });
    const file = fileRow.getByRole('button', { name: '清单.txt' });
    const displayedDate = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(Date.parse(modifiedAt));
    const fileSize = fileRow.getByRole('cell', { name: '1.5 KiB' });
    expect(fileRow.getByText(displayedDate)).toHaveAttribute('datetime', modifiedAt);
    expect(folderRow.getByRole('cell', { name: '—' })).toBeInTheDocument();
    expect(emptyFile.getByRole('cell', { name: '0 B' })).toBeInTheDocument();
    expect(emptyFile.getByRole('cell', { name: '—' })).toBeInTheDocument();

    await user.click(folder);
    expect(folder).toHaveAttribute('aria-pressed', 'true');
    expect(listDirectory).toHaveBeenCalledExactlyOnceWith(space.root, undefined);

    await user.keyboard('{Control>}');
    await user.click(fileSize);
    expect(file).toHaveAttribute('aria-pressed', 'true');
    expect(folder).toHaveAttribute('aria-pressed', 'true');
    await user.click(fileSize);
    expect(file).toHaveAttribute('aria-pressed', 'false');
    expect(folder).toHaveAttribute('aria-pressed', 'true');
    await user.dblClick(folderRow.getByText(displayedDate));
    expect(listDirectory).toHaveBeenCalledTimes(1);
    await user.click(fileSize);
    await user.keyboard('{/Control}');

    await user.click(fileSize);
    expect(file).toHaveAttribute('aria-pressed', 'true');
    expect(folder).toHaveAttribute('aria-pressed', 'false');
    await user.dblClick(fileSize);
    expect(listDirectory).toHaveBeenCalledTimes(1);

    await user.dblClick(folderRow.getByText(displayedDate));
    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(child, undefined));
    const breadcrumb = screen.getByRole('navigation', { name: '当前目录' });
    expect(within(breadcrumb).getByText('资料')).toHaveAttribute('aria-current', 'page');
    await user.click(within(breadcrumb).getByRole('button', { name: space.name }));
    expect(await screen.findByRole('button', { name: '资料' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it('opens information for a right-clicked row and measures selected folders in the dialog', async () => {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const file = { ...space.root, locator: 'file' };
  const folder = { ...space.root, locator: 'folder' };
  const modifiedAt = '2026-01-02T03:04:06.000Z';
  const displayedDate = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(Date.parse(modifiedAt));
  let finish!: (result: BrowserResult<number | null>) => void;
  const calculation = new Promise<BrowserResult<number | null>>((resolve) => {
    finish = resolve;
  });
  const measureDirectorySize = vi.fn<StorageBrowserApi['measureDirectorySize']>(() => calculation);
  const cancelDirectoryMeasurement = vi.fn<StorageBrowserApi['cancelDirectoryMeasurement']>(
    async () => success(undefined),
  );
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async () =>
    success({
      entries: [
        {
          ref: file,
          name: '清单.txt',
          kind: 'file',
          displayPath: 'C:\\项目盘\\清单.txt',
          size: 512,
          modifiedAt,
          capabilities: {},
        },
        {
          ref: folder,
          name: '资料',
          kind: 'directory',
          displayPath: 'C:\\项目盘\\资料',
          modifiedAt: '2026-01-01T03:04:06.000Z',
          capabilities: {},
        },
      ],
    }),
  );
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () => success([{ ...emptyLocalConnection, spaces: [space] }]),
      listDirectory,
      measureDirectorySize,
      cancelDirectoryMeasurement,
    },
  });
  try {
    await renderWorkspace();
    await user.click(await screen.findByRole('button', { name: space.name }));
    const fileButton = await screen.findByRole('button', { name: '清单.txt' });
    const folderButton = screen.getByRole('button', { name: '资料' });
    await user.click(folderButton);
    await user.pointer({ keys: '[MouseRight]', target: fileButton });
    expect(fileButton).toHaveAttribute('aria-pressed', 'true');
    expect(folderButton).toHaveAttribute('aria-pressed', 'false');
    await user.click(await screen.findByRole('menuitem', { name: '信息' }));
    const single = within(await screen.findByRole('dialog', { name: '信息' }));
    expect(single.getByText('清单.txt')).toBeInTheDocument();
    expect(single.getByText('512 B')).toBeInTheDocument();
    expect(single.getByText(displayedDate)).toBeInTheDocument();
    expect(single.getByText('C:\\项目盘\\清单.txt')).toBeInTheDocument();
    expect(measureDirectorySize).not.toHaveBeenCalled();

    await user.click(single.getByRole('button', { name: '关闭' }));
    await user.keyboard('{Control>}');
    await user.click(folderButton);
    await user.keyboard('{/Control}');
    const folderRow = within(screen.getByRole('row', { name: /资料/ }));
    await user.pointer({
      keys: '[MouseRight]',
      target: folderRow.getByRole('cell', { name: '—' }),
    });
    await user.click(await screen.findByRole('menuitem', { name: '信息' }));
    const multiple = within(await screen.findByRole('dialog', { name: '信息' }));
    expect(multiple.getByText('共 2 项')).toBeInTheDocument();
    expect(multiple.getByText('C:\\项目盘\\')).toBeInTheDocument();
    expect(multiple.getByText(displayedDate)).toBeInTheDocument();
    expect(multiple.getByText('计算中…')).toBeInTheDocument();
    expect(measureDirectorySize).toHaveBeenLastCalledWith(expect.any(String), [folder]);
    finish(success(1536));
    expect(await multiple.findByText('2 KiB')).toBeInTheDocument();
    expect(multiple.queryByText('计算中…')).not.toBeInTheDocument();

    await user.click(multiple.getByRole('button', { name: '关闭' }));
    expect(cancelDirectoryMeasurement).toHaveBeenLastCalledWith(
      measureDirectorySize.mock.lastCall?.[0],
    );
    expect(listDirectory).toHaveBeenCalledExactlyOnceWith(space.root, undefined);
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
    expect(await screen.findByText('此文件夹为空。')).toBeInTheDocument();
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
    expect(screen.getByText('此文件夹为空。')).toBeInTheDocument();
    await user.click(drive);
    expect(screen.getByText('first-after')).toBeInTheDocument();
    expect(screen.getByText('second-after')).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledTimes(5);
  } finally {
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
    await user.click(localLink);
    await screen.findByText('此文件夹为空。');

    await user.click(authorizeLink);
    const dialog = within(screen.getByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: '在浏览器中授权' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(reauthorize).toHaveBeenCalledExactlyOnceWith(drive.connectionId);

    await user.click(cloudLink);
    expect(await screen.findByRole('button', { name: '更新后的资料' })).toBeInTheDocument();
    await user.click(localLink);
    expect(screen.getByText('此文件夹为空。')).toBeInTheDocument();
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

it('enables local sorting only after the entire directory is loaded', async () => {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  function pauseLastPage() {
    let resolve!: () => void;
    const promise = new Promise<void>((finish) => {
      resolve = finish;
    });
    return { promise, resolve };
  }

  const finishLastPage = pauseLastPage();
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (ref, cursor) => {
    if (ref.locator !== space.root.locator) return success({ entries: [] });
    if (cursor === 'next') return success({ entries: [], nextCursor: 'last' });
    if (cursor === 'last') {
      await finishLastPage.promise;
      return success({
        entries: [
          {
            ref: { ...ref, locator: 'file2' },
            name: 'file2',
            kind: 'file',
            size: 0,
            modifiedAt: '2026-01-01T01:00:00Z',
            capabilities: {},
          },
        ],
      });
    }
    return success({
      entries: [
        {
          ref: { ...ref, locator: 'file10' },
          name: 'file10',
          kind: 'file',
          size: 1536,
          modifiedAt: '2026-01-01T02:00:00+02:00',
          capabilities: {},
        },
        {
          ref: { ...ref, locator: 'unknown' },
          name: 'unknown',
          kind: 'directory',
          capabilities: {},
        },
      ],
      nextCursor: 'next',
    });
  });
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () => success([{ ...emptyLocalConnection, spaces: [space] }]),
      listDirectory,
    },
  });
  try {
    await renderWorkspace();
    await user.click(await screen.findByRole('button', { name: space.name }));
    const table = within(await screen.findByRole('table', { name: '文件和文件夹' }));
    const entryNames = () =>
      table
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getByRole('button').textContent);

    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(space.root, 'last'));
    expect(entryNames()).toEqual(['file10', 'unknown']);
    expect(screen.queryByLabelText('正在加载目录')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
    for (const header of table.getAllByRole('columnheader')) {
      expect(within(header).queryByRole('button')).not.toBeInTheDocument();
      expect(header.querySelector('svg')).not.toBeInTheDocument();
      expect(header).not.toHaveAttribute('aria-sort');
    }

    finishLastPage.resolve();
    const name = await table.findByRole('button', { name: '名称' });
    const modifiedAt = table.getByRole('button', { name: '修改时间' });
    const size = table.getByRole('button', { name: '大小' });

    await user.click(name);
    expect(entryNames()).toEqual(['file2', 'file10', 'unknown']);
    expect(table.getByRole('columnheader', { name: '名称' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await user.click(name);
    expect(entryNames()).toEqual(['unknown', 'file10', 'file2']);
    expect(table.getByRole('columnheader', { name: '名称' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );

    await user.click(modifiedAt);
    expect(entryNames()).toEqual(['file10', 'file2', 'unknown']);
    await user.click(modifiedAt);
    expect(entryNames()).toEqual(['file2', 'file10', 'unknown']);

    await user.click(size);
    expect(entryNames()).toEqual(['file2', 'file10', 'unknown']);
    await user.click(size);
    expect(entryNames()).toEqual(['file10', 'file2', 'unknown']);
    expect(listDirectory.mock.calls).toEqual([
      [space.root, undefined],
      [space.root, 'next'],
      [space.root, 'last'],
    ]);

    await user.dblClick(table.getByRole('button', { name: 'unknown' }));
    await screen.findByText('此文件夹为空。');
    const breadcrumb = screen.getByRole('navigation', { name: '当前目录' });
    await user.click(within(breadcrumb).getByRole('button', { name: space.name }));
    const reopenedTable = within(await screen.findByRole('table', { name: '文件和文件夹' }));
    expect(reopenedTable.getByRole('button', { name: 'file10' })).toBeInTheDocument();
    expect(reopenedTable.getByRole('button', { name: 'file2' })).toBeInTheDocument();
    expect(reopenedTable.getByRole('button', { name: '名称' })).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledTimes(4);
  } finally {
    finishLastPage.resolve();
    vi.unstubAllGlobals();
  }
});

it('changes language in General settings and keeps the current folder open', async () => {
  const user = userEvent.setup();
  const drive: Space = {
    id: 'personal-root',
    connectionId: 'studio',
    name: { messageKey: 'myDrive' },
    root: { connectionId: 'studio', spaceId: 'personal-root', locator: 'root' },
  };
  const sharedDrive: Space = {
    id: 'shared:team',
    connectionId: 'studio',
    name: 'My Drive',
    root: { connectionId: 'studio', spaceId: 'shared:team', locator: 'team' },
  };
  const child = { ...drive.root, locator: 'child' };
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (ref) => {
    if (ref.locator === child.locator) return { ok: false, code: 'PermissionDenied' };
    return success({
      entries: [{ ref: child, name: '项目文件夹', kind: 'directory', capabilities: {} }],
    });
  });
  const connections: StorageConnectionSummary[] = [
    {
      id: 'studio',
      provider: 'google-drive',
      name: '工作室',
      needsAuthorization: false,
      spaces: [drive, sharedDrive],
    },
  ];
  const setLanguage = vi.fn(async () => ({ preference: 'en', language: 'en' }));
  vi.stubGlobal('desktop', {
    language: { set: setLanguage },
    storage: { listConnections: async () => success(connections), listDirectory },
  });
  const previousLang = document.documentElement.lang;
  try {
    await renderWorkspace();
    const navigation = screen.getByRole('navigation', { name: '存储' });
    const personal = await within(navigation).findByRole('button', { name: '我的云端硬盘' });
    expect(within(navigation).getByRole('button', { name: 'My Drive' })).toBeInTheDocument();
    await user.click(personal);
    await user.click(await screen.findByRole('button', { name: '项目文件夹' }));
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('没有权限访问这个位置。');

    const settingsEntry = screen.getByRole('button', { name: '设置' });
    expect(screen.queryByRole('combobox', { name: '语言' })).not.toBeInTheDocument();
    await user.click(settingsEntry);
    const settings = within(await screen.findByRole('dialog', { name: '设置' }));
    const categories = within(settings.getByRole('tablist', { name: '设置分类' }));
    expect(categories.getByRole('tab', { name: '通用', selected: true })).toBeInTheDocument();
    const general = within(settings.getByRole('tabpanel', { name: '通用' }));
    await user.selectOptions(general.getByRole('combobox', { name: '语言' }), 'en');
    expect(setLanguage).toHaveBeenCalledExactlyOnceWith('en');
    expect(await settings.findByRole('combobox', { name: 'Language' })).toHaveValue('en');
    await user.click(settings.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'You do not have permission to access this location.',
    );
    const breadcrumb = screen.getByRole('navigation', { name: 'Current directory' });
    expect(within(breadcrumb).getByRole('button', { name: 'My Drive' })).toBeInTheDocument();
    expect(within(breadcrumb).getByText('项目文件夹')).toHaveAttribute('aria-current', 'page');
    const sidebar = screen.getByRole('navigation', { name: 'Storage' });
    expect(within(sidebar).getByRole('button', { name: 'My Drive', current: 'location' })).toBe(
      personal,
    );
    expect(listDirectory.mock.calls).toEqual([
      [drive.root, undefined],
      [child, undefined],
    ]);
    expect(document.documentElement).toHaveAttribute('lang', 'en');

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const reopened = within(await screen.findByRole('dialog', { name: 'Settings' }));
    expect(await reopened.findByRole('combobox', { name: 'Language' })).toHaveValue('en');
  } finally {
    vi.unstubAllGlobals();
    document.documentElement.lang = previousLang;
  }
});
