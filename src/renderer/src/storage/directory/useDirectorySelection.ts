import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useStorageWorkspace } from '../storage-workspace-context';
import { useCurrentDirectory } from './current-directory-context';
import { isDirectoryBlankTarget } from './directory-blank-target';
import { directoryKey, type DirectoryEntries } from './directory-cache';
import type { DirectoryRow, DirectorySelectionModifiers } from './directory-types';

interface SelectionState {
  locators: ReadonlySet<string>;
  anchor: string | null;
}

interface SelectionOptions {
  rows: readonly DirectoryRow[];
  completedEntries: DirectoryEntries | undefined;
  scrollElement: HTMLDivElement | null;
}

export function useDirectorySelection({ rows, completedEntries, scrollElement }: SelectionOptions) {
  const { directoryCache: cache } = useStorageWorkspace();
  const { ref: parent } = useCurrentDirectory();
  const [selection, setSelection] = useState<SelectionState>(() => ({
    locators: new Set(),
    anchor: null,
  }));

  if (completedEntries) {
    const remaining = [...selection.locators].filter((locator) => completedEntries.has(locator));
    const anchor =
      selection.anchor !== null && completedEntries.has(selection.anchor) ? selection.anchor : null;
    if (remaining.length < selection.locators.size || anchor !== selection.anchor) {
      setSelection({
        locators:
          remaining.length < selection.locators.size ? new Set(remaining) : selection.locators,
        anchor,
      });
    }
  }

  useLayoutEffect(
    () =>
      cache.subscribeRenames((change) => {
        if (directoryKey(change.parent) !== directoryKey(parent)) return;
        const previous = change.previous.locator;
        const locator = change.entry.ref.locator;
        setSelection((current) => {
          const anchor = current.anchor === previous ? locator : current.anchor;
          if (!current.locators.has(previous)) {
            return anchor === current.anchor ? current : { ...current, anchor };
          }
          const locators = new Set(current.locators);
          locators.delete(previous);
          locators.add(locator);
          return { locators, anchor };
        });
      }),
    [cache, parent],
  );

  const selectEntry = useCallback(
    (locator: string, { toggle, range }: DirectorySelectionModifiers) => {
      const end = rows.findIndex(({ entry }) => entry.ref.locator === locator);
      if (end < 0) return;

      setSelection((current) => {
        const start = range
          ? rows.findIndex(({ entry }) => entry.ref.locator === current.anchor)
          : -1;
        const anchor = start < 0 ? locator : current.anchor;
        if (start >= 0) {
          const locators = toggle ? new Set(current.locators) : new Set<string>();
          for (const { entry } of rows.slice(Math.min(start, end), Math.max(start, end) + 1)) {
            locators.add(entry.ref.locator);
          }
          return { locators, anchor };
        }
        if (!toggle) return { locators: new Set([locator]), anchor };

        const locators = new Set(current.locators);
        if (!range && locators.has(locator)) locators.delete(locator);
        else locators.add(locator);
        return { locators, anchor };
      });
    },
    [rows],
  );
  const selectAll = useCallback(() => {
    setSelection((current) => ({
      locators: new Set(rows.map(({ entry }) => entry.ref.locator)),
      anchor: rows.some(({ entry }) => entry.ref.locator === current.anchor)
        ? current.anchor
        : (rows[0]?.entry.ref.locator ?? null),
    }));
  }, [rows]);
  const selectOnly = useCallback((locator: string | null) => {
    setSelection({ locators: new Set(locator === null ? [] : [locator]), anchor: locator });
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
  const selectForContextMenu = useCallback((locator: string) => {
    setSelection((current) => ({
      locators: current.locators.has(locator) ? current.locators : new Set([locator]),
      anchor: locator,
    }));
  }, []);

  return {
    selectedLocators: selection.locators,
    selectEntry,
    selectAll,
    selectOnly,
    selectForContextMenu,
  };
}
