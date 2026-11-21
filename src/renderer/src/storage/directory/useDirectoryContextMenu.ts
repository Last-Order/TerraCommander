import { useCallback, useState } from 'react';
import type { Entry } from '@shared/storage';

type DirectoryContextMenu =
  | { kind: 'entry'; locator: string }
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
  const [menu, setMenu] = useState<DirectoryContextMenu | null>(null);

  const menuEntry = menu?.kind === 'entry' ? entries.get(menu.locator) : undefined;
  if (phase === 'ready' && menu?.kind === 'entry' && !menuEntry) setMenu(null);
  const blankMenuPosition = menu?.kind === 'blank' ? { x: menu.x, y: menu.y } : null;

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  const showEntryMenu = useCallback(
    ({ ref: { locator } }: Entry) => {
      selectForContextMenu(locator);
      setMenu({ kind: 'entry', locator });
    },
    [selectForContextMenu],
  );

  const showBlankMenu = useCallback((position: { x: number; y: number }) => {
    setMenu({ kind: 'blank', ...position });
  }, []);

  return {
    menuEntry,
    entryMenuOpened: menuEntry !== undefined,
    blankMenuPosition,
    anyMenuOpened: menuEntry !== undefined || blankMenuPosition !== null,
    closeMenu,
    showEntryMenu,
    showBlankMenu,
  };
}
