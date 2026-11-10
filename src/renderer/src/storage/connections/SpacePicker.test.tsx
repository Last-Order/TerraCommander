import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { Space } from '../../../../shared/storage';
import type { StorageBrowserApi } from '../../../../shared/storage-browser';
import { renderWorkspace } from '../../testing/render-app';
import { success } from '../../testing/storage-browser-fixtures';

it('refreshes the space picker explicitly and keeps valid draft selections', async () => {
  const user = userEvent.setup();
  const connectionId = 'studio';
  const makeSpace = (id: string, name: string) =>
    ({
      id,
      connectionId,
      name,
      root: { connectionId, spaceId: id, locator: id },
    }) satisfies Space;
  const myDrive = makeSpace('my-drive', '个人盘');
  const team = makeSpace('team', '团队盘');
  const archive = makeSpace('archive', '归档盘');
  const added = makeSpace('new', '新空间');
  const listSpaces = vi
    .fn<StorageBrowserApi['listSpaces']>()
    .mockResolvedValueOnce(
      success([myDrive, team, archive].map((space) => ({ space, available: true }))),
    )
    .mockResolvedValueOnce({ ok: false, code: 'NetworkError' })
    .mockResolvedValueOnce(
      success([myDrive, team, added].map((space) => ({ space, available: true }))),
    );
  const saveSpaces = vi.fn<StorageBrowserApi['saveSpaces']>(async () => success(undefined));
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () =>
        success([
          {
            id: connectionId,
            provider: 'google-drive',
            name: '工作室',
            needsAuthorization: false,
            spaces: [myDrive],
          },
        ]),
      listSpaces,
      saveSpaces,
    },
  });
  try {
    await renderWorkspace();
    await user.click(await screen.findByRole('button', { name: '管理 工作室 显示的空间' }));
    const picker = within(screen.getByRole('dialog', { name: '管理显示的空间' }));
    const refresh = picker.getByRole('button', { name: '刷新空间列表' });
    await user.click(await picker.findByRole('checkbox', { name: team.name }));
    await user.click(picker.getByRole('checkbox', { name: archive.name }));
    expect(listSpaces).toHaveBeenCalledExactlyOnceWith(connectionId);

    await user.click(refresh);
    expect(await picker.findByRole('alert')).toHaveTextContent('暂时无法连接到存储服务');
    expect(picker.getByRole('checkbox', { name: archive.name })).toBeChecked();

    await user.click(refresh);
    expect(await picker.findByRole('checkbox', { name: added.name })).not.toBeChecked();
    expect(picker.queryByRole('alert')).not.toBeInTheDocument();
    expect(picker.queryByRole('checkbox', { name: archive.name })).not.toBeInTheDocument();
    expect(picker.getByRole('checkbox', { name: myDrive.name })).toBeChecked();
    expect(picker.getByRole('checkbox', { name: team.name })).toBeChecked();
    expect(listSpaces.mock.calls).toEqual([
      [connectionId],
      [connectionId, true],
      [connectionId, true],
    ]);

    await user.click(picker.getByRole('button', { name: '保存' }));
    expect(saveSpaces).toHaveBeenCalledExactlyOnceWith(connectionId, [myDrive.id, team.id]);
  } finally {
    vi.unstubAllGlobals();
  }
});
