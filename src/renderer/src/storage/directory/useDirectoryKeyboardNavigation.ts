import { useCallback, useEffect, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { isDirectoryNavigationKey, resolveDirectoryNavigationIndex } from './directory-navigation';
import type {
  DirectoryRow,
  DirectorySelectionModifiers,
  DirectoryViewportRequest,
} from './directory-types';

interface UseDirectoryKeyboardNavigationOptions {
  tableRef: RefObject<HTMLTableElement | null>;
  scrollElement: HTMLDivElement | null;
  rows: readonly DirectoryRow[];
  rowIndexByLocator: ReadonlyMap<string, number>;
  virtualized: boolean;
  selectedLocators: ReadonlySet<string>;
  activeLocator: string | null;
  navigationBlocked: boolean;
  getPageStep: () => number;
  syncScrollPadding: () => void;
  onSelect: (locator: string, modifiers: DirectorySelectionModifiers) => void;
  onActiveChange: (locator: string | null) => void;
  onRequestViewport: (request: DirectoryViewportRequest) => void;
}

export function useDirectoryKeyboardNavigation({
  tableRef,
  scrollElement,
  rows,
  rowIndexByLocator,
  virtualized,
  selectedLocators,
  activeLocator,
  navigationBlocked,
  getPageStep,
  syncScrollPadding,
  onSelect,
  onActiveChange,
  onRequestViewport,
}: UseDirectoryKeyboardNavigationOptions) {
  const navigateTo = useCallback(
    (nextIndex: number, modifiers: { ctrlKey: boolean; shiftKey: boolean }) => {
      const next = rows[nextIndex];
      if (!next) return;
      const { locator } = next.entry.ref;
      if (!modifiers.ctrlKey) {
        onSelect(locator, { toggle: false, range: modifiers.shiftKey });
      } else {
        onActiveChange(locator);
      }
      if (virtualized) {
        syncScrollPadding();
      }
      onRequestViewport({ locator, align: 'auto', focus: true });
    },
    [rows, onSelect, onActiveChange, virtualized, syncScrollPadding, onRequestViewport],
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

      const activeIndex =
        activeLocator !== null ? (rowIndexByLocator.get(activeLocator) ?? -1) : -1;
      const fallbackIndex =
        activeIndex >= 0
          ? activeIndex
          : rows.findIndex(({ entry }) => selectedLocators.has(entry.ref.locator));
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
  }, [
    tableRef,
    scrollElement,
    rows,
    rowIndexByLocator,
    selectedLocators,
    activeLocator,
    navigationBlocked,
    getPageStep,
    navigateTo,
  ]);

  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    const row = event.target.closest<HTMLTableRowElement>('tr[data-index]');
    const entry = rows[Number(row?.dataset.index)];
    if (entry) onActiveChange(entry.entry.ref.locator);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || navigationBlocked) return;
    if (!(event.target instanceof HTMLButtonElement)) return;
    const row = event.target.closest<HTMLTableRowElement>('tr[data-index]');
    if (!row) return;
    const currentIndex = Number(row.dataset.index);

    if (event.key === 'Tab' && virtualized && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
      const next = rows[nextIndex];
      if (!next) return;
      event.preventDefault();
      syncScrollPadding();
      onActiveChange(next.entry.ref.locator);
      onRequestViewport({ locator: next.entry.ref.locator, align: 'auto', focus: true });
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

  return { onFocus, onKeyDown };
}
