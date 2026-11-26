import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { DirectoryViewState, DirectoryViewStore } from './directory-view-store';

export const DirectoryViewContext = createContext<DirectoryViewStore | null>(null);

export function useDirectoryViewStore(): DirectoryViewStore {
  const store = useContext(DirectoryViewContext);
  if (!store) throw new Error('DirectoryViewContext is not configured.');
  return store;
}

export function useDirectoryView<T>(selector: (state: DirectoryViewState) => T): T {
  const store = useDirectoryViewStore();
  return useStore(store, selector);
}
