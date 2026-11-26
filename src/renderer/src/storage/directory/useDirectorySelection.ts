import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { entryKey, type Entry } from '@shared/storage';
import { useStorageWorkspace } from '../storage-workspace-context';
import { useCurrentDirectory } from './current-directory-context';
import { isDirectoryBlankTarget } from './directory-blank-target';
import type { DirectoryEntries } from './directory-cache';
import {
  createEmptyDirectorySelection,
  migrateRenamedDirectorySelection,
  pruneDirectorySelection,
  selectAllDirectoryEntries,
  selectDirectoryEntry,
  selectDirectoryEntryForContextMenu,
  selectManyDirectoryEntries,
  selectOnlyDirectoryEntry,
  setActiveDirectoryEntry,
  type DirectorySelectionState,
} from './directory-selection';
import type { DirectoryRow, DirectorySelectionModifiers } from './directory-types';

interface SelectionOptions {
  entries: DirectoryEntries;
  ready: boolean;
  rows: readonly DirectoryRow[];
  rowIndexByLocator: ReadonlyMap<string, number>;
  scrollElement: HTMLDivElement | null;
}

export function useDirectorySelection({
  entries,
  ready,
  rows,
  rowIndexByLocator,
  scrollElement,
}: SelectionOptions) {
  const { directoryCache: cache } = useStorageWorkspace();
  const { ref: parent } = useCurrentDirectory();
  const [selection, setSelection] = useState<DirectorySelectionState>(
    createEmptyDirectorySelection,
  );
  const [prunedEntries, setPrunedEntries] = useState<DirectoryEntries | undefined>(() =>
    ready ? entries : undefined,
  );

  if (ready && prunedEntries !== entries) {
    setPrunedEntries(entries);
    const pruned = pruneDirectorySelection(selection, entries);
    if (pruned !== selection) setSelection(pruned);
  }

  useLayoutEffect(
    () =>
      cache.subscribeRenames((change) => {
        if (entryKey(change.parent) !== entryKey(parent)) return;
        setSelection((current) =>
          migrateRenamedDirectorySelection(
            current,
            change.previous.locator,
            change.entry.ref.locator,
          ),
        );
      }),
    [cache, parent],
  );

  const selectEntry = useCallback(
    (locator: string, modifiers: DirectorySelectionModifiers) => {
      setSelection((current) =>
        selectDirectoryEntry(current, rows, rowIndexByLocator, locator, modifiers),
      );
    },
    [rows, rowIndexByLocator],
  );

  const selectAll = useCallback(() => {
    setSelection((current) => selectAllDirectoryEntries(current, rows, rowIndexByLocator));
  }, [rows, rowIndexByLocator]);

  const selectOnly = useCallback((locator: string | null) => {
    setSelection(selectOnlyDirectoryEntry(locator));
  }, []);

  const selectMany = useCallback((locators: readonly string[], primaryLocator?: string | null) => {
    setSelection(selectManyDirectoryEntries(locators, primaryLocator));
  }, []);

  const selectForContextMenu = useCallback((locator: string) => {
    setSelection((current) => selectDirectoryEntryForContextMenu(current, locator));
  }, []);

  const setActiveLocator = useCallback((locator: string | null) => {
    setSelection((current) => setActiveDirectoryEntry(current, locator));
  }, []);

  useEffect(() => {
    if (!scrollElement) return;
    const clearOnBlankClick = (event: MouseEvent) => {
      if (event.ctrlKey || event.shiftKey || event.metaKey) return;
      if (!isDirectoryBlankTarget(event.target)) return;
      selectOnly(null);
    };
    scrollElement.addEventListener('click', clearOnBlankClick);
    return () => scrollElement.removeEventListener('click', clearOnBlankClick);
  }, [scrollElement, selectOnly]);

  const selectedEntries = useMemo(() => {
    const selected: Entry[] = [];
    for (const locator of selection.locators) {
      const entry = entries.get(locator);
      if (entry) selected.push(entry);
    }
    return selected;
  }, [entries, selection.locators]);

  return {
    selectedLocators: selection.locators,
    anchorLocator: selection.anchor,
    activeLocator: selection.active,
    selectedEntries,
    selectEntry,
    selectAll,
    selectOnly,
    selectMany,
    selectForContextMenu,
    setActiveLocator,
  };
}
