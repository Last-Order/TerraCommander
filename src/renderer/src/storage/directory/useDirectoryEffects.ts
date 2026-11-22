import { useCallback, useSyncExternalStore } from 'react';
import type { Entry, EntryRef } from '@shared/storage';
import { useStorageWorkspace } from '../storage-workspace-context';

const noopSubscribe = () => () => {};

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

export function useSelectionBusy(entries: readonly Entry[], enabled: boolean): boolean {
  const { directoryEffects } = useStorageWorkspace();
  const subscribe = enabled ? directoryEffects.subscribeBusy : noopSubscribe;
  return useSyncExternalStore(subscribe, () =>
    enabled ? directoryEffects.hasBusyEntries(entries) : false,
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
