import { useCallback, useSyncExternalStore } from 'react';
import { useStorageWorkspace } from '@renderer/storage/storage-workspace-context';
import type { Entry, EntryRef } from '@shared/storage';

export function useEntryBusy(ref: EntryRef): boolean {
  const { directoryEffects } = useStorageWorkspace();
  const { connectionId, spaceId, locator } = ref;
  const subscribe = useCallback(
    (listener: () => void) =>
      directoryEffects.subscribeEntry({ connectionId, spaceId, locator }, listener),
    [directoryEffects, connectionId, spaceId, locator],
  );
  return useSyncExternalStore(subscribe, () => directoryEffects.isBusy(ref));
}

export function useSelectionBusy(entries: readonly Entry[]): boolean {
  const { directoryEffects } = useStorageWorkspace();
  return useSyncExternalStore(directoryEffects.subscribeBusy, () =>
    directoryEffects.hasBusyEntries(entries),
  );
}

export function useDirectoryRenames(parent: EntryRef): ReadonlyMap<string, string> {
  const { directoryEffects } = useStorageWorkspace();
  const { connectionId, spaceId, locator } = parent;
  const subscribe = useCallback(
    (listener: () => void) =>
      directoryEffects.subscribeDirectoryRenames({ connectionId, spaceId, locator }, listener),
    [directoryEffects, connectionId, spaceId, locator],
  );
  return useSyncExternalStore(subscribe, () => directoryEffects.getDirectoryRenames(parent));
}
