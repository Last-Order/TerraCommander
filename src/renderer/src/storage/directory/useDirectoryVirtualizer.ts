import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  resolveDirectoryPageStep,
  resolveDirectoryScrollPadding,
  type DirectoryScrollPadding,
} from './directory-navigation';
import type { DirectoryRow, DirectoryViewportCommand } from './directory-types';

const estimatedRowHeight = 36;

function parsePixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

interface UseDirectoryVirtualizerOptions {
  rows: readonly DirectoryRow[];
  rowIndexByLocator: ReadonlyMap<string, number>;
  scrollElement: HTMLDivElement | null;
  canSort: boolean;
  pinnedLocators: readonly string[];
  viewportCommand: DirectoryViewportCommand | null;
  onViewportCommandHandled: (seq: number) => void;
}

export function useDirectoryVirtualizer({
  rows,
  rowIndexByLocator,
  scrollElement,
  canSort,
  pinnedLocators,
  viewportCommand,
  onViewportCommandHandled,
}: UseDirectoryVirtualizerOptions) {
  const tableRef = useRef<HTMLTableElement>(null);
  const enabled = rows.length > 100;
  const [scrollMargin, setScrollMargin] = useState(0);
  const [scrollPadding, setScrollPadding] = useState<DirectoryScrollPadding>({ start: 0, end: 0 });

  const pinnedIndexes = useMemo(() => {
    const indexes: number[] = [];
    for (const locator of pinnedLocators) {
      const index = rowIndexByLocator.get(locator);
      if (index !== undefined) indexes.push(index);
    }
    return indexes;
  }, [pinnedLocators, rowIndexByLocator]);

  const rangeExtractor = useCallback(
    (range: Range) => {
      // Keep active, target, and dragged rows mounted even when scrolled out of view.
      const indexes = new Set(defaultRangeExtractor(range));
      for (const index of pinnedIndexes) indexes.add(index);
      return [...indexes].sort((a, b) => a - b);
    },
    [pinnedIndexes],
  );

  // oxlint-disable-next-line react/incompatible-library -- React Compiler is not enabled in this app.
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: rows.length,
    getScrollElement: () => scrollElement,
    getItemKey: useCallback((index) => rows[index]?.entry.ref.locator ?? index, [rows]),
    estimateSize: () => estimatedRowHeight,
    overscan: 8,
    enabled,
    scrollMargin,
    scrollPaddingStart: scrollPadding.start,
    scrollPaddingEnd: scrollPadding.end,
    rangeExtractor,
  });

  const readScrollPadding = useCallback((): DirectoryScrollPadding => {
    if (!scrollElement) return { start: 0, end: 0 };
    const style = getComputedStyle(scrollElement);
    return resolveDirectoryScrollPadding({
      viewportHeight: scrollElement.clientHeight,
      headerHeight: tableRef.current?.tHead?.offsetHeight ?? 0,
      scrollPaddingStart: parsePixelValue(style.scrollPaddingTop),
      scrollPaddingEnd: parsePixelValue(style.scrollPaddingBottom),
      rowHeight: estimatedRowHeight,
    });
  }, [scrollElement]);

  const syncScrollPadding = useCallback(() => {
    const next = readScrollPadding();
    setScrollPadding((previous) =>
      previous.start === next.start && previous.end === next.end ? previous : next,
    );
    return next;
  }, [readScrollPadding]);

  useLayoutEffect(() => {
    const table = tableRef.current;
    const scroll = scrollElement;
    if (!enabled || !table?.tHead || !scroll) return;

    const measureOffset = () => {
      setScrollMargin(
        table.tHead!.getBoundingClientRect().bottom -
          scroll.getBoundingClientRect().top +
          scroll.scrollTop,
      );
      syncScrollPadding();
    };
    measureOffset();
    const observer = new ResizeObserver(measureOffset);
    observer.observe(scroll);
    observer.observe(table.tHead);
    // Alerts above the table can change the list's offset without resizing the viewport.
    for (const sibling of scroll.children) {
      if (sibling === table) break;
      observer.observe(sibling);
    }
    return () => observer.disconnect();
  }, [enabled, rows, scrollElement, canSort, syncScrollPadding]);

  useLayoutEffect(() => {
    if (viewportCommand === null) return;
    const targetIndex = rowIndexByLocator.get(viewportCommand.locator) ?? -1;
    if (targetIndex < 0) {
      onViewportCommandHandled(viewportCommand.seq);
      return;
    }
    if (enabled) {
      virtualizer.scrollToIndex(targetIndex, { align: viewportCommand.align });
    }
    const row = tableRef.current?.querySelector<HTMLTableRowElement>(
      `tr[data-index="${targetIndex}"]`,
    );
    if (!enabled) {
      row?.scrollIntoView({
        block: viewportCommand.align === 'center' ? 'center' : 'nearest',
        inline: 'nearest',
      });
    }
    if (viewportCommand.focus) {
      row?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    }
    onViewportCommandHandled(viewportCommand.seq);
  }, [viewportCommand, rowIndexByLocator, enabled, virtualizer, onViewportCommandHandled]);

  const getPageStep = useCallback(() => {
    if (!scrollElement) return 10;
    return resolveDirectoryPageStep(
      scrollElement.clientHeight,
      readScrollPadding(),
      estimatedRowHeight,
    );
  }, [scrollElement, readScrollPadding]);

  return {
    tableRef,
    enabled,
    scrollMargin,
    virtualizer,
    getPageStep,
    syncScrollPadding,
  };
}
