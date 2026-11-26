import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import {
  isDirectoryNavigationKey,
  resolveDirectoryNavigationIndex,
  resolveDirectoryPageStep,
  resolveDirectoryScrollPadding,
  type DirectoryScrollPadding,
} from './directory-navigation';
import type {
  DirectoryRevealTarget,
  DirectoryRow,
  DirectorySelectionModifiers,
} from './directory-types';

const estimatedRowHeight = 36;

function parsePixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

interface UseDirectoryVirtualizerOptions {
  rows: readonly DirectoryRow[];
  scrollElement: HTMLDivElement | null;
  canSort: boolean;
  revealTarget?: DirectoryRevealTarget | null | undefined;
  draggingLocator?: string | null | undefined;
  selectedLocators: ReadonlySet<string>;
  navigationBlocked: boolean;
  onSelect: (locator: string, modifiers: DirectorySelectionModifiers) => void;
}

export function useDirectoryVirtualizer({
  rows,
  scrollElement,
  canSort,
  revealTarget = null,
  draggingLocator = null,
  selectedLocators,
  navigationBlocked,
  onSelect,
}: UseDirectoryVirtualizerOptions) {
  const tableRef = useRef<HTMLTableElement>(null);
  const enabled = rows.length > 100;
  const [scrollMargin, setScrollMargin] = useState(0);
  const [scrollPadding, setScrollPadding] = useState<DirectoryScrollPadding>({ start: 0, end: 0 });
  const [focusedLocator, setFocusedLocator] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ locator: string } | null>(null);
  const focusedIndex = useMemo(
    () =>
      focusedLocator === null
        ? -1
        : rows.findIndex(({ entry }) => entry.ref.locator === focusedLocator),
    [rows, focusedLocator],
  );
  const targetIndex = useMemo(
    () =>
      focusTarget === null
        ? -1
        : rows.findIndex(({ entry }) => entry.ref.locator === focusTarget.locator),
    [rows, focusTarget],
  );
  const revealIndex = useMemo(
    () =>
      revealTarget === null
        ? -1
        : rows.findIndex(({ entry }) => entry.ref.locator === revealTarget.locator),
    [rows, revealTarget],
  );
  const draggingIndex = useMemo(
    () =>
      draggingLocator === null
        ? -1
        : rows.findIndex(({ entry }) => entry.ref.locator === draggingLocator),
    [rows, draggingLocator],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      // Keep keyboard focus and active drag source mounted even when scrolled out of view.
      const indexes = new Set(defaultRangeExtractor(range));
      if (focusedIndex >= 0) indexes.add(focusedIndex);
      if (targetIndex >= 0) indexes.add(targetIndex);
      if (revealIndex >= 0) indexes.add(revealIndex);
      if (draggingIndex >= 0) indexes.add(draggingIndex);
      return [...indexes].sort((a, b) => a - b);
    },
    [focusedIndex, targetIndex, revealIndex, draggingIndex],
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
    if (targetIndex < 0) {
      setFocusTarget(null);
      return;
    }
    if (enabled) {
      virtualizer.scrollToIndex(targetIndex, { align: 'auto' });
    }
    const row = tableRef.current?.querySelector<HTMLTableRowElement>(
      `tr[data-index="${targetIndex}"]`,
    );
    if (!enabled) {
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    row?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    setFocusTarget(null);
  }, [focusTarget, targetIndex, enabled, virtualizer]);

  const getPageStep = useCallback(() => {
    if (!scrollElement) return 10;
    return resolveDirectoryPageStep(
      scrollElement.clientHeight,
      readScrollPadding(),
      estimatedRowHeight,
    );
  }, [scrollElement, readScrollPadding]);

  const navigateTo = useCallback(
    (nextIndex: number, modifiers: { ctrlKey: boolean; shiftKey: boolean }) => {
      const next = rows[nextIndex];
      if (!next) return;
      const { locator } = next.entry.ref;
      if (!modifiers.ctrlKey) {
        onSelect(locator, { toggle: false, range: modifiers.shiftKey });
      }
      if (enabled) {
        syncScrollPadding();
      }
      setFocusTarget({ locator });
    },
    [rows, onSelect, enabled, syncScrollPadding],
  );

  useEffect(() => {
    const doc = tableRef.current?.ownerDocument;
    if (!doc) return;

    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        navigationBlocked ||
        event.altKey ||
        event.metaKey ||
        !isDirectoryNavigationKey(event.key) ||
        rows.length === 0
      ) {
        return;
      }
      if (doc.querySelector('[aria-modal="true"], dialog[open]')) return;
      const active = doc.activeElement;
      if (active instanceof Element && active.closest('tr[data-index]')) return;
      if (active !== doc.body && active !== scrollElement) return;

      const fallbackIndex = rows.findIndex(({ entry }) => selectedLocators.has(entry.ref.locator));
      const nextIndex = resolveDirectoryNavigationIndex(
        rows.length,
        fallbackIndex,
        event.key,
        getPageStep(),
      );
      if (nextIndex < 0) return;

      event.preventDefault();
      navigateTo(nextIndex, event);
    };

    doc.addEventListener('keydown', onDocumentKeyDown);
    return () => doc.removeEventListener('keydown', onDocumentKeyDown);
  }, [rows, scrollElement, selectedLocators, navigationBlocked, getPageStep, navigateTo]);

  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    const row = event.target.closest<HTMLTableRowElement>('tr[data-index]');
    const entry = rows[Number(row?.dataset.index)];
    setFocusedLocator(entry?.entry.ref.locator ?? null);
  };
  const onBlur = (event: FocusEvent<HTMLTableElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocusedLocator(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || navigationBlocked) return;
    if (!(event.target instanceof HTMLButtonElement)) return;
    const row = event.target.closest<HTMLTableRowElement>('tr[data-index]');
    if (!row) return;
    const currentIndex = Number(row.dataset.index);

    if (event.key === 'Tab' && enabled && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
      const next = rows[nextIndex];
      if (!next) return;
      event.preventDefault();
      syncScrollPadding();
      setFocusTarget({ locator: next.entry.ref.locator });
      return;
    }

    if (event.key === ' ' && !event.altKey && !event.metaKey) {
      const current = rows[currentIndex];
      if (!current) return;
      event.preventDefault();
      onSelect(current.entry.ref.locator, { toggle: event.ctrlKey, range: event.shiftKey });
      return;
    }

    if (isDirectoryNavigationKey(event.key) && !event.altKey && !event.metaKey) {
      const nextIndex = resolveDirectoryNavigationIndex(
        rows.length,
        currentIndex,
        event.key,
        getPageStep(),
      );
      if (nextIndex < 0) return;
      event.preventDefault();
      navigateTo(nextIndex, event);
    }
  };

  return { tableRef, enabled, scrollMargin, virtualizer, onFocus, onBlur, onKeyDown };
}
