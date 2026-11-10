import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { Space } from '../../../shared/storage';
import type { StorageBrowserApi, StorageConnectionSummary } from '../../../shared/storage-browser';
import { renderWorkspace } from '../testing/render-app';
import { success } from '../testing/storage-browser-fixtures';

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
