import { createContext, useContext } from 'react';
import type { DirectoryCache } from './directory/directory-cache';

export interface StorageWorkspaceContextValue {
  directoryCache: DirectoryCache;
  onAuthRequired: () => void;
  reauthorize: (connectionId: string) => void;
}

export const StorageWorkspaceContext = createContext<StorageWorkspaceContextValue | null>(null);

export function useStorageWorkspace(): StorageWorkspaceContextValue {
  const workspace = useContext(StorageWorkspaceContext);
  if (!workspace) throw new Error('StorageWorkspaceContext is not configured.');
  return workspace;
}
