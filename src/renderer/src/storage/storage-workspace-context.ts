import { createContext, useContext } from 'react';
import type { DirectoryCache } from './directory/state/directory-cache';
import type { DirectoryEffectsStore } from './directory/state/directory-effects';
import type { SelectionSummaryStore } from './directory/state/selection-summary';

export interface StorageWorkspaceContextValue {
  directoryCache: DirectoryCache;
  directoryEffects: DirectoryEffectsStore;
  selectionSummary: SelectionSummaryStore;
  onAuthRequired: () => void;
  reauthorize: (connectionId: string) => void;
}

export const StorageWorkspaceContext = createContext<StorageWorkspaceContextValue | null>(null);

export function useStorageWorkspace(): StorageWorkspaceContextValue {
  const workspace = useContext(StorageWorkspaceContext);
  if (!workspace) throw new Error('StorageWorkspaceContext is not configured.');
  return workspace;
}
