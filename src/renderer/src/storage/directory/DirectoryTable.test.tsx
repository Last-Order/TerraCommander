import { MantineProvider, Menu } from '@mantine/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useState, type ComponentProps } from 'react';
import type { i18n } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  emptyLocalConnection,
  localConnectionId,
  type StorageBrowserApi,
} from '../../../../shared/storage-browser';
import { createRendererI18n } from '../../i18n/create-renderer-i18n';
import { renderWorkspace } from '../../testing/render-app';
import { success } from '../../testing/storage-browser-fixtures';
import { DirectoryTable, type DirectoryRow } from './DirectoryTable';

const rowHeight = 36;
const headerOffset = 52;
let viewportHeight = 360;
const resizeObservers = new Set<ResizeObserverMock>();

class ResizeObserverMock {
  readonly elements = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }

  observe(element: Element) {
    this.elements.add(element);
  }

  unobserve(element: Element) {
    this.elements.delete(element);
  }

  disconnect() {
    this.elements.clear();
    resizeObservers.delete(this);
  }
}

beforeEach(() => {
  viewportHeight = 360;
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === 'directory-scroll' || this.matches('div[aria-busy]')
      ? viewportHeight
      : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.matches('tr[data-index]') ? rowHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroll = this.closest<HTMLElement>('[data-testid="directory-scroll"], div[aria-busy]');
    return this.tagName === 'THEAD'
      ? new DOMRect(0, headerOffset - rowHeight - (scroll?.scrollTop ?? 0), 800, rowHeight)
      : new DOMRect(0, 0, 800, viewportHeight);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resizeObservers.clear();
});

function createRows(count: number): DirectoryRow[] {
  return Array.from({ length: count }, (_, index) => ({
    entry: {
      ref: { connectionId: localConnectionId, spaceId: 'drive', locator: String(index) },
      name: `file${index}.txt`,
      kind: 'file',
      modifiedAt: '2026-01-01T00:00:00Z',
      capabilities: {},
    },
    name: `file${index}.txt`,
    disabled: false,
    modifiedAt: Date.parse('2026-01-01T00:00:00Z'),
    size: index,
  }));
}

type TableProps = Omit<ComponentProps<typeof DirectoryTable>, 'scrollElement'>;

function TableFixture({ props, i18n }: { props: TableProps; i18n: i18n }) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const attachScroll = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      element.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
        element.scrollTop =
          typeof options === 'number' ? (y ?? 0) : (options?.top ?? element.scrollTop);
      });
    }
    setScrollElement(element);
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <div data-testid="directory-scroll" ref={attachScroll}>
          <Menu>
            <DirectoryTable {...props} scrollElement={scrollElement} />
          </Menu>
        </div>
        <button type="button">After listing</button>
      </MantineProvider>
    </I18nextProvider>
  );
}

async function renderTable(rows = createRows(10_000)) {
  const i18n = await createRendererI18n('en');
  const dateFormatter = new Intl.DateTimeFormat('en');
  const sizeFormatter = new Intl.NumberFormat('en');
  const formatDate = vi.fn(dateFormatter.format.bind(dateFormatter));
  Object.defineProperty(dateFormatter, 'format', { value: formatDate });
  const props = {
    rows,
    sort: null,
    canSort: true,
    loadingWithoutEntries: false,
    selectedLocators: new Set<string>(),
    dateFormatter,
    sizeFormatter,
    onSelect: vi.fn(),
    onSelectAll: vi.fn(),
    onSort: vi.fn(),
    onContextMenu: vi.fn(),
    onOpen: vi.fn(),
  };
  const view = render(<TableFixture props={props} i18n={i18n} />);
  const rerender = (nextProps: TableProps) =>
    view.rerender(<TableFixture props={nextProps} i18n={i18n} />);
  const scroll = screen.getByTestId('directory-scroll');
  const table = screen.getByRole('table');
  const mountedRows = () => table.querySelectorAll('tbody tr[data-index]');
  const scrollToRow = (index: number) =>
    fireEvent.scroll(scroll, { target: { scrollTop: headerOffset + index * rowHeight } });

  return { ...view, rerender, props, rows, scroll, table, mountedRows, scrollToRow, formatDate };
}

it('bounds mounted rows for 10,000 files and reaches the middle and last file', async () => {
  const { table, mountedRows, scrollToRow, props } = await renderTable();
  expect(table).toHaveAttribute('aria-rowcount', '10001');
  expect(screen.getByRole('button', { name: 'file0.txt' }).closest('tr')).toHaveAttribute(
    'aria-rowindex',
    '2',
  );
  expect(mountedRows().length).toBeLessThan(40);
  expect(screen.queryByRole('button', { name: 'file9999.txt' })).not.toBeInTheDocument();

  scrollToRow(5000);
  const middle = screen.getByRole('button', { name: 'file5000.txt' });
  expect(screen.queryByRole('button', { name: 'file0.txt' })).not.toBeInTheDocument();
  expect(mountedRows().length).toBeLessThan(40);
  fireEvent.click(middle, { ctrlKey: true });
  expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('5000', { toggle: true, range: false });
  fireEvent.contextMenu(middle);
  expect(props.onContextMenu).toHaveBeenCalledWith(props.rows[5000]?.entry);

  scrollToRow(9990);
  expect(screen.getByRole('button', { name: 'file9999.txt' }).closest('tr')).toHaveAttribute(
    'aria-rowindex',
    '10001',
  );
  expect(mountedRows().length).toBeLessThan(40);
});

it('preserves selection across scrolling and skips formatting unchanged rows', async () => {
  const { rerender, props, scrollToRow, formatDate, mountedRows } = await renderTable();
  formatDate.mockClear();
  const selected = { ...props, selectedLocators: new Set(['0']) };
  rerender(selected);
  expect(formatDate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'file0.txt' })).toHaveAttribute('aria-pressed', 'true');

  scrollToRow(5000);
  rerender({ ...selected, selectedLocators: new Set(['0', '5000']) });
  expect(screen.getByRole('button', { name: 'file5000.txt' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  scrollToRow(0);
  expect(screen.getByRole('button', { name: 'file0.txt' })).toHaveAttribute('aria-pressed', 'true');
  expect(mountedRows().length).toBeLessThan(40);
});

it('keeps focus mounted while scrolling and tabs in logical row order across the window', async () => {
  const user = userEvent.setup();
  const { scrollToRow, mountedRows, scroll } = await renderTable();
  const first = screen.getByRole('button', { name: 'file0.txt' });
  act(() => first.focus());
  scrollToRow(5000);
  expect(first).toHaveFocus();
  expect(mountedRows().length).toBeLessThan(40);

  await user.tab();
  expect(screen.getByRole('button', { name: 'file1.txt' })).toHaveFocus();
  expect(scroll.scrollTop).toBeLessThan(headerOffset + 2 * rowHeight);
  await user.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'file0.txt' })).toHaveFocus();

  scrollToRow(5000);
  const lastMounted = mountedRows()[mountedRows().length - 1];
  const index = Number((lastMounted as HTMLElement).dataset.index);
  act(() =>
    within(lastMounted as HTMLElement)
      .getByRole('button')
      .focus(),
  );
  expect(screen.queryByRole('button', { name: `file${index + 1}.txt` })).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByRole('button', { name: `file${index + 1}.txt` })).toHaveFocus();
});

it('updates the visible window when the scroll viewport grows', async () => {
  const { scroll, mountedRows } = await renderTable();
  const initialCount = mountedRows().length;
  act(() => {
    viewportHeight = 720;
    for (const observer of resizeObservers) {
      if (observer.elements.has(scroll)) observer.callback([], observer);
    }
  });
  expect(mountedRows().length).toBeGreaterThan(initialCount);
  expect(mountedRows().length).toBeLessThan(50);
});

it('renders updated sort order and switches back to a small listing after refresh', async () => {
  const { rows, rerender, props, scrollToRow, mountedRows } = await renderTable();
  rerender({ ...props, rows: rows.toReversed() });
  expect(screen.getByRole('button', { name: 'file9999.txt' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'file0.txt' })).not.toBeInTheDocument();
  scrollToRow(5000);
  const retained = rows.slice(0, 3);
  rerender({ ...props, rows: retained });
  expect(mountedRows()).toHaveLength(3);
  expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '4');
  for (const row of retained) {
    expect(screen.getByRole('button', { name: row.name })).toBeInTheDocument();
  }
  expect(screen.getByRole('table').querySelector('tbody tr[aria-hidden]')).toBeNull();
});

it('selects ranges and all entries across unmounted rows in a 10,000-file directory', async () => {
  const rows = createRows(10_000);
  const root = { connectionId: localConnectionId, spaceId: 'drive', locator: '.' };
  const listDirectory = vi.fn<StorageBrowserApi['listDirectory']>(async () =>
    success({ entries: rows.map(({ entry }) => entry) }),
  );
  vi.stubGlobal('desktop', {
    storage: {
      listConnections: async () =>
        success([
          {
            ...emptyLocalConnection,
            spaces: [{ id: 'drive', connectionId: localConnectionId, name: '项目盘', root }],
          },
        ]),
      listDirectory,
    },
  });
  const user = userEvent.setup();
  await renderWorkspace();
  await user.click(await screen.findByRole('button', { name: '项目盘' }));
  const first = await screen.findByRole('button', { name: 'file0.txt' });
  const table = screen.getByRole('table', { name: '文件和文件夹' });
  const scroll = table.parentElement;
  const scrollToRow = (index: number) =>
    fireEvent.scroll(scroll!, { target: { scrollTop: headerOffset + index * rowHeight } });
  const item = (index: number) => screen.getByRole('button', { name: `file${index}.txt` });
  const mountedRows = () => table.querySelectorAll('tbody tr[data-index]');

  await user.click(first);
  scrollToRow(5000);
  expect(screen.queryByRole('button', { name: 'file2500.txt' })).not.toBeInTheDocument();
  fireEvent.click(item(5000), { shiftKey: true });
  expect(item(5000)).toHaveAttribute('aria-pressed', 'true');
  expect(item(5001)).toHaveAttribute('aria-pressed', 'false');
  expect(mountedRows().length).toBeLessThan(40);
  scrollToRow(2500);
  expect(item(2500)).toHaveAttribute('aria-pressed', 'true');
  scrollToRow(0);
  expect(item(0)).toHaveAttribute('aria-pressed', 'true');

  act(() => item(0).focus());
  expect(fireEvent.keyDown(item(0), { key: 'a', ctrlKey: true })).toBe(false);
  scrollToRow(9990);
  expect(item(9999)).toHaveAttribute('aria-pressed', 'true');
  expect(mountedRows().length).toBeLessThan(40);
  expect(listDirectory).toHaveBeenCalledExactlyOnceWith(root, undefined);
});
