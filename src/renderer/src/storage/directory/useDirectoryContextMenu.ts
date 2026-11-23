import { useCallback, useState } from 'react';
import type { Entry } from '@shared/storage';

export interface DirectoryContextMenuPosition {
  x: number;
  y: number;
}

export type DirectoryContextMenuState =
  | { kind: 'entry'; entry: Entry; x: number; y: number }
  | { kind: 'blank'; x: number; y: number };

type StoredContextMenu =
  | { kind: 'entry'; locator: string; x: number; y: number }
  | { kind: 'blank'; x: number; y: number };

interface UseDirectoryContextMenuOptions {
  entries: ReadonlyMap<string, Entry>;
  phase: string;
  selectForContextMenu: (locator: string) => void;
}

export function useDirectoryContextMenu({
  entries,
  phase,
  selectForContextMenu,
}: UseDirectoryContextMenuOptions) {
  const [stored, setStored] = useState<StoredContextMenu | null>(null);

  const menuEntry = stored?.kind === 'entry' ? entries.get(stored.locator) : undefined;
  if (phase === 'ready' && stored?.kind === 'entry' && !menuEntry) setStored(null);

  let activeMenu: DirectoryContextMenuState | null = null;
  if (stored?.kind === 'blank') {
    activeMenu = stored;
  } else if (stored?.kind === 'entry' && menuEntry) {
    activeMenu = { kind: 'entry', entry: menuEntry, x: stored.x, y: stored.y };
  }

  const closeMenu = useCallback(() => {
    setStored(null);
  }, []);

  const showEntryMenu = useCallback(
    ({ ref: { locator } }: Entry, position: DirectoryContextMenuPosition) => {
      selectForContextMenu(locator);
      setStored({ kind: 'entry', locator, ...position });
    },
    [selectForContextMenu],
  );

  const showBlankMenu = useCallback((position: DirectoryContextMenuPosition) => {
    setStored({ kind: 'blank', ...position });
  }, []);

  return {
    activeMenu,
    menuEntry,
    opened: activeMenu !== null,
    closeMenu,
    showEntryMenu,
    showBlankMenu,
  };
}
