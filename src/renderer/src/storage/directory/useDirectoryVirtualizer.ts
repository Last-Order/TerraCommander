import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import type { DirectoryRevealTarget, DirectoryRow } from './directory-types';

export function useDirectoryVirtualizer(
  rows: readonly DirectoryRow[],
  scrollElement: HTMLDivElement | null,
  canSort: boolean,
  revealTarget: DirectoryRevealTarget | null = null,
) {
  const tableRef = useRef<HTMLTableElement>(null);
  const enabled = rows.length > 100;
  const [scrollMargin, setScrollMargin] = useState(0);
  const [focusedLocator, setFocusedLocator] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const focusedIndex = useMemo(
    () =>
      focusedLocator === null
        ? -1
        : rows.findIndex(({ entry }) => entry.ref.locator === focusedLocator),
    [rows, focusedLocator],
  );
  const targetIndex = useMemo(
    () =>
      focusTarget === null ? -1 : rows.findIndex(({ entry }) => entry.ref.locator === focusTarget),
    [rows, focusTarget],
  );
  const revealIndex = useMemo(
    () =>
      revealTarget === null
        ? -1
        : rows.findIndex(({ entry }) => entry.ref.locator === revealTarget.locator),
    [rows, revealTarget],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      // Keep keyboard focus mounted even when the user scrolls it out of view.
      const indexes = new Set(defaultRangeExtractor(range));
      if (focusedIndex >= 0) indexes.add(focusedIndex);
      if (targetIndex >= 0) indexes.add(targetIndex);
      if (revealIndex >= 0) indexes.add(revealIndex);
      return [...indexes].sort((a, b) => a - b);
    },
    [focusedIndex, targetIndex, revealIndex],
  );
  // oxlint-disable-next-line react/incompatible-library -- React Compiler is not enabled in this app.
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: rows.length,
    getScrollElement: () => scrollElement,
    getItemKey: useCallback((index) => rows[index]?.entry.ref.locator ?? index, [rows]),
    estimateSize: () => 36,
    overscan: 8,
    enabled,
    scrollMargin,
    rangeExtractor,
  });

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
  }, [enabled, rows, scrollElement, canSort]);

  useLayoutEffect(() => {
    if (revealIndex < 0) return;
    if (enabled) {
      virtualizer.scrollToIndex(revealIndex, { align: 'center' });
    } else {
      tableRef.current
        ?.querySelector<HTMLTableRowElement>(`tr[data-index="${revealIndex}"]`)
        ?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }, [revealTarget, revealIndex, enabled, virtualizer]);

  useLayoutEffect(() => {
    if (focusTarget === null) return;
    const button = tableRef.current?.querySelector<HTMLButtonElement>(
      `tr[data-index="${targetIndex}"] button`,
    );
    if (button) {
      virtualizer.scrollToIndex(targetIndex, { align: 'auto' });
      button.focus({ preventScroll: true });
    }
    setFocusTarget(null);
  }, [focusTarget, targetIndex, virtualizer]);

  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    if (!enabled) return;
    const row = event.target.closest<HTMLTableRowElement>('tr[data-index]');
    const entry = rows[Number(row?.dataset.index)];
    setFocusedLocator(entry?.entry.ref.locator ?? null);
  };
  const onBlur = (event: FocusEvent<HTMLTableElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocusedLocator(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (!enabled || event.key !== 'Tab' || !(event.target instanceof HTMLButtonElement)) return;
    const row = event.target.closest<HTMLTableRowElement>('tr[data-index]');
    if (!row) return;
    const nextIndex = Number(row.dataset.index) + (event.shiftKey ? -1 : 1);
    const next = rows[nextIndex];
    if (!next) return;
    event.preventDefault();
    setFocusTarget(next.entry.ref.locator);
  };

  return { tableRef, enabled, scrollMargin, virtualizer, onFocus, onBlur, onKeyDown };
}
