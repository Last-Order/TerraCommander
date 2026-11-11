import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { EntryPage, Space } from '../../../../shared/storage';
import {
  emptyLocalConnection,
  localConnectionId,
  type BrowserResult,
  type StorageBrowserApi,
} from '../../../../shared/storage-browser';
import { renderWorkspace } from '../../testing/render-app';
import { pausePage, success } from '../../testing/storage-browser-fixtures';

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

it('drops missing selections after a complete directory refresh', async () => {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const removed = {
    ref: { ...space.root, locator: 'removed' },
    name: '已删除.txt',
    kind: 'file',
    capabilities: {},
  } as const;
  const retained = { ...removed, ref: { ...space.root, locator: 'retained' }, name: '保留.txt' };
  const updated = { ...retained, name: '保留-刷新后.txt' };
  const listDirectory = vi
    .fn<StorageBrowserApi['listDirectory']>()
    .mockResolvedValueOnce(success({ entries: [removed, retained] }))
    .mockResolvedValueOnce(success({ entries: [], nextCursor: 'next' }))
    .mockResolvedValueOnce(success({ entries: [updated] }))
    .mockResolvedValueOnce(success({ entries: [removed, updated] }));

  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () => success([{ ...emptyLocalConnection, spaces: [space] }]),
      listDirectory,
    },
  });
  try {
    await renderWorkspace();
    await user.click(await screen.findByRole('button', { name: space.name }));
    const removedButton = await screen.findByRole('button', { name: removed.name });
    await user.click(removedButton);
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('button', { name: retained.name }));
    await user.keyboard('{/Control}');

    const refresh = screen.getByRole('button', { name: '刷新目录' });
    await user.click(refresh);
    const updatedButton = await screen.findByRole('button', { name: updated.name });
    expect(removedButton).not.toBeInTheDocument();
    expect(updatedButton).toHaveAttribute('aria-pressed', 'true');

    await user.click(refresh);
    expect(await screen.findByRole('button', { name: removed.name })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(updatedButton).toHaveAttribute('aria-pressed', 'true');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps the completed listing and selection when a refresh fails on a later page', async () => {
  const user = userEvent.setup();
  const space = {
    id: 'drive',
    connectionId: localConnectionId,
    name: '项目盘',
    root: { connectionId: localConnectionId, spaceId: 'drive', locator: '.' },
  } satisfies Space;
  const retained = {
    ref: { ...space.root, locator: 'retained' },
    name: '保留.txt',
    kind: 'file',
    capabilities: {},
  } as const;
  const partial = { ...retained, ref: { ...space.root, locator: 'partial' }, name: '新分页.txt' };
  const refreshed = { ...retained, name: '刷新后.txt' };
  const laterPage = pausePage<BrowserResult<EntryPage>>();
  const listDirectory = vi
    .fn<StorageBrowserApi['listDirectory']>()
    .mockResolvedValueOnce(success({ entries: [retained] }))
    .mockResolvedValueOnce(success({ entries: [partial], nextCursor: 'next' }))
    .mockReturnValueOnce(laterPage.promise)
    .mockResolvedValueOnce(success({ entries: [refreshed] }));

  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () => success([{ ...emptyLocalConnection, spaces: [space] }]),
      listDirectory,
    },
  });
  try {
    await renderWorkspace();
    await user.click(await screen.findByRole('button', { name: space.name }));
    const selected = await screen.findByRole('button', { name: retained.name });
    await user.click(selected);
    await user.click(screen.getByRole('button', { name: '刷新目录' }));

    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(space.root, 'next'));
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: partial.name })).not.toBeInTheDocument();
    laterPage.resolve({ ok: false, code: 'NetworkError' });
    const error = await screen.findByRole('alert');
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: partial.name })).not.toBeInTheDocument();

    await user.click(within(error).getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('button', { name: refreshed.name })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(listDirectory).toHaveBeenLastCalledWith(space.root, undefined);
  } finally {
    laterPage.resolve(success({ entries: [] }));
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
  const finishFirstPage = pausePage<void>();
  const finishLastPage = pausePage<void>();
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async (ref, cursor) => {
    if (ref.locator !== space.root.locator) return success({ entries: [] });
    if (cursor === undefined) return success({ entries: [], nextCursor: 'first' });
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
    await finishFirstPage.promise;
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
    const loadingTable = await screen.findByRole('table', { name: '文件和文件夹' });
    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(space.root, 'first'));
    expect(loadingTable.parentElement).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('正在加载目录');
    expect(within(loadingTable).getAllByRole('columnheader')).toHaveLength(3);
    expect(within(loadingTable).getAllByRole('row')).toHaveLength(1);
    expect(loadingTable.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    finishFirstPage.resolve();
    const table = within(loadingTable);
    const entryNames = () =>
      table
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getByRole('button').textContent);

    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(space.root, 'last'));
    expect(entryNames()).toEqual(['file10', 'unknown']);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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
      [space.root, 'first'],
      [space.root, 'next'],
      [space.root, 'last'],
    ]);

    await user.dblClick(table.getByRole('button', { name: 'unknown' }));
    await screen.findByText('此文件夹为空');
    const breadcrumb = screen.getByRole('navigation', { name: '当前目录' });
    await user.click(within(breadcrumb).getByRole('button', { name: space.name }));
    const reopenedTable = within(await screen.findByRole('table', { name: '文件和文件夹' }));
    expect(reopenedTable.getByRole('button', { name: 'file10' })).toBeInTheDocument();
    expect(reopenedTable.getByRole('button', { name: 'file2' })).toBeInTheDocument();
    expect(reopenedTable.getByRole('button', { name: '名称' })).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledTimes(5);
  } finally {
    finishFirstPage.resolve();
    finishLastPage.resolve();
    vi.unstubAllGlobals();
  }
});
