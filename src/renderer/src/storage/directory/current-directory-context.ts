import { createContext, useContext } from 'react';
import type { Capabilities, EntryRef } from '@shared/storage';

export interface CurrentDirectoryContextValue {
  ref: EntryRef;
  path: string;
  capabilities?: Capabilities | undefined;
  ancestors: readonly EntryRef[];
}

export const CurrentDirectoryContext = createContext<CurrentDirectoryContextValue | null>(null);

export function useCurrentDirectory(): CurrentDirectoryContextValue {
  const directory = useContext(CurrentDirectoryContext);
  if (!directory) throw new Error('CurrentDirectoryContext is not configured.');
  return directory;
}
