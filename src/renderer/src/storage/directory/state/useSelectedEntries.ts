import { useContext, useMemo } from 'react';
import { useStore } from 'zustand';
import type { Entry } from '@shared/storage';
import { DirectoryViewContext } from './directory-view-context';
import type { DirectoryViewStore } from './directory-view-store';

export function useSelectedEntries(store?: DirectoryViewStore): readonly Entry[] {
  const contextStore = useContext(DirectoryViewContext);
  const target = store ?? contextStore;
  if (!target) throw new Error('DirectoryViewContext is not configured.');

  const entries = useStore(target, (state) => state.entries);
  const selectedLocators = useStore(target, (state) => state.selectedLocators);

  return useMemo(() => {
    const selected: Entry[] = [];
    for (const locator of selectedLocators) {
      const entry = entries.get(locator);
      if (entry) selected.push(entry);
    }
    return selected;
  }, [entries, selectedLocators]);
}
