import { createContext, useContext } from 'react';
import type { Capabilities, EntryRef } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';

export interface CurrentDirectoryContextValue {
  ref: EntryRef;
  path: string;
  capabilities?: Capabilities | undefined;
  ancestors: readonly EntryRef[];
  canCreateDirectory: boolean;
  canUpload: boolean;
  canUploadFolder: boolean;
}

export function createCurrentDirectoryValue({
  ref,
  path,
  capabilities,
  ancestors,
}: {
  ref: EntryRef;
  path: string;
  capabilities?: Capabilities | undefined;
  ancestors: readonly EntryRef[];
}): CurrentDirectoryContextValue {
  const isLocal = ref.connectionId === localConnectionId;
  const canWrite = capabilities?.write?.support !== 'unsupported';
  const canCreateDirectory = capabilities?.createDirectory?.support !== 'unsupported';
  const canUpload = !isLocal && canWrite;
  const canUploadFolder = canUpload && canCreateDirectory;

  return {
    ref,
    path,
    capabilities,
    ancestors,
    canCreateDirectory,
    canUpload,
    canUploadFolder,
  };
}

export const CurrentDirectoryContext = createContext<CurrentDirectoryContextValue | null>(null);

export function useCurrentDirectory(): CurrentDirectoryContextValue {
  const directory = useContext(CurrentDirectoryContext);
  if (!directory) throw new Error('CurrentDirectoryContext is not configured.');
  return directory;
}
