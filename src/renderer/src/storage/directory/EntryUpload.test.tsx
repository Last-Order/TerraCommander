import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Entry, EntryPage, Space } from '@shared/storage';
import type { BrowserResult, StorageBrowserApi } from '@shared/storage-browser';
import { createFakeTasksApi } from '@renderer/testing/fake-tasks-api';
import { renderWorkspace } from '@renderer/testing/render-app';
import { pausePage, success } from '@renderer/testing/storage-browser-fixtures';

afterEach(() => vi.unstubAllGlobals());

it('uploads to the displayed folder and keeps the new entry when an older listing settles', async () => {
  const user = userEvent.setup();
  const drive = {
    id: 'my-drive',
    connectionId: 'account',
    name: '云盘',
    root: { connectionId: 'account', spaceId: 'my-drive', locator: 'root' },
  } satisfies Space;
  const stale = pausePage<BrowserResult<EntryPage>>();
  const listDirectory = vi
    .fn<StorageBrowserApi['listDirectory']>()
    .mockResolvedValueOnce(success({ entries: [] }))
    .mockReturnValueOnce(stale.promise);
  const { api, emit } = createFakeTasksApi();
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () =>
        success([
          {
            id: drive.connectionId,
            provider: 'google-drive',
            name: '账号',
            needsAuthorization: false,
            spaces: [drive],
          },
        ]),
      listDirectory,
    },
    tasks: api,
  });
  await renderWorkspace();
  await user.click(await screen.findByRole('button', { name: drive.name }));
  const button = await screen.findByRole('button', { name: '上传文件…' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  expect(api.uploadFile).toHaveBeenCalledExactlyOnceWith({
    parent: drive.root,
    directoryPath: drive.name,
  });

  await user.click(screen.getByRole('button', { name: '刷新目录' }));
  await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));
  const entry = {
    ref: { ...drive.root, locator: 'new-file' },
    name: '新文件.txt',
    kind: 'file',
    capabilities: {},
  } satisfies Entry;
  act(() =>
    emit({ type: 'directory-changed', change: { kind: 'added', parent: drive.root, entry } }),
  );
  await act(async () => stale.resolve(success({ entries: [] })));

  const table = within(await screen.findByRole('table', { name: '文件和文件夹' }));
  expect(table.getByRole('button', { name: entry.name })).toBeInTheDocument();
  expect(listDirectory).toHaveBeenCalledTimes(2);
});
