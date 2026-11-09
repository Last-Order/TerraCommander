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

it('selects files and folders with a click and opens only folders with a double click', async () => {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const child = { ...space.root, locator: 'child' };
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (ref) =>
    success({
      entries:
        ref.locator === space.root.locator
          ? [
              { ref: child, name: '资料', kind: 'directory', capabilities: {} },
              {
                ref: { ...ref, locator: 'file' },
                name: '清单.txt',
                kind: 'file',
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
    const folder = await screen.findByRole('button', { name: '资料' });
    const file = screen.getByRole('button', { name: '清单.txt' });

    await user.click(folder);
    expect(folder).toHaveAttribute('aria-pressed', 'true');
    expect(listDirectory).toHaveBeenCalledExactlyOnceWith(space.root, undefined);

    await user.click(file);
    expect(file).toHaveAttribute('aria-pressed', 'true');
    expect(folder).toHaveAttribute('aria-pressed', 'false');
    await user.dblClick(file);
    expect(listDirectory).toHaveBeenCalledTimes(1);

    await user.dblClick(folder);
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

it('loads only the next directory page and refreshes the visible pages with the new cursor', async () => {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const connections: StorageConnectionSummary[] = [
    {
      ...emptyLocalConnection,
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
    await renderWorkspace();
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
