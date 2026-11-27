import { useMemo } from 'react';
import type { Entry } from '@shared/storage';
import { useDirectoryView } from './directory-view-context';

export function useSelectedEntries(): readonly Entry[] {
  const entries = useDirectoryView((state) => state.entries);
  const selectedLocators = useDirectoryView((state) => state.selectedLocators);

  return useMemo(() => {
    const selected: Entry[] = [];
    for (const locator of selectedLocators) {
      const entry = entries.get(locator);
      if (entry) selected.push(entry);
    }
    return selected;
  }, [entries, selectedLocators]);
}
