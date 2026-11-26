import { useCallback, useEffect, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { useDirectoryViewStore } from '../state/directory-view-context';
import { isDirectoryNavigationKey, resolveDirectoryNavigationIndex } from './directory-navigation';

interface UseDirectoryKeyboardNavigationOptions {
  tableRef: RefObject<HTMLTableElement | null>;
  scrollElement: HTMLDivElement | null;
  virtualized: boolean;
  getPageStep: () => number;
  syncScrollPadding: () => void;
}

export function useDirectoryKeyboardNavigation({
  tableRef,
  scrollElement,
  virtualized,
  getPageStep,
  syncScrollPadding,
}: UseDirectoryKeyboardNavigationOptions) {
  const store = useDirectoryViewStore();

  const navigateTo = useCallback(
    (nextIndex: number, modifiers: { ctrlKey: boolean; shiftKey: boolean }) => {
      const state = store.getState();
      const next = state.rows[nextIndex];
      if (!next) return;
      const { locator } = next.entry.ref;
      if (!modifiers.ctrlKey) {
        state.selectEntry(locator, { toggle: false, range: modifiers.shiftKey });
      } else {
        state.setActiveLocator(locator);
      }
      if (virtualized) {
        syncScrollPadding();
      }
      state.requestViewport({ locator, align: 'auto', focus: true });
    },
    [store, virtualized, syncScrollPadding],
  );

  useEffect(() => {
    const doc = tableRef.current?.ownerDocument;
    if (!doc) return;

    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      const state = store.getState();
      if (
        event.defaultPrevented ||
        event.isComposing ||
        state.navigationBlocked ||
        state.loadingWithoutEntries ||
        event.altKey ||
        event.metaKey ||
        !isDirectoryNavigationKey(event.key) ||
        state.rows.length === 0
      ) {
        return;
      }
      if (doc.querySelector('[aria-modal="true"], dialog[open]')) return;
      const active = doc.activeElement;
      if (active instanceof Element && active.closest('tr[data-index]')) return;
      if (active !== doc.body && active !== scrollElement) return;

      const activeIndex =
        state.activeLocator !== null
          ? (state.rowIndexByLocator.get(state.activeLocator) ?? -1)
          : -1;
      const fallbackIndex =
        activeIndex >= 0
          ? activeIndex
          : state.rows.findIndex(({ entry }) => state.selectedLocators.has(entry.ref.locator));
      const nextIndex = resolveDirectoryNavigationIndex(
        state.rows.length,
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
  }, [store, tableRef, scrollElement, getPageStep, navigateTo]);

  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    const row = event.target.closest<HTMLTableRowElement>('tr[data-index]');
    const state = store.getState();
    const entry = state.rows[Number(row?.dataset.index)];
    if (entry) state.setActiveLocator(entry.entry.ref.locator);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const state = store.getState();
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      state.navigationBlocked ||
      state.loadingWithoutEntries
    ) {
      return;
    }
    if (!(event.target instanceof HTMLButtonElement)) return;
    const row = event.target.closest<HTMLTableRowElement>('tr[data-index]');
    if (!row) return;
    const currentIndex = Number(row.dataset.index);

    if (event.key === 'Tab' && virtualized && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
      const next = state.rows[nextIndex];
      if (!next) return;
      event.preventDefault();
      syncScrollPadding();
      state.setActiveLocator(next.entry.ref.locator);
      state.requestViewport({ locator: next.entry.ref.locator, align: 'auto', focus: true });
      return;
    }

    if (event.key === ' ' && !event.altKey && !event.metaKey) {
      const current = state.rows[currentIndex];
      if (!current) return;
      event.preventDefault();
      state.selectEntry(current.entry.ref.locator, {
        toggle: event.ctrlKey,
        range: event.shiftKey,
      });
      return;
    }

    if (isDirectoryNavigationKey(event.key) && !event.altKey && !event.metaKey) {
      const nextIndex = resolveDirectoryNavigationIndex(
        state.rows.length,
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
