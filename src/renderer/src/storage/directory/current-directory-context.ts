import { createContext, useContext } from 'react';
import type { Capabilities, EntryRef } from '@shared/storage';
import type { StorageProvider } from '@shared/storage-browser';

export interface CurrentDirectoryContextValue {
  ref: EntryRef;
  provider: StorageProvider;
  path: string;
  capabilities?: Capabilities | undefined;
  ancestors: readonly EntryRef[];
  canWrite: boolean;
  canCreateDirectory: boolean;
  canUpload: boolean;
  canUploadFolder: boolean;
  canDropLocalFiles: boolean;
}

export function createCurrentDirectoryValue({
  ref,
  provider,
  path,
  capabilities,
  ancestors,
}: {
  ref: EntryRef;
  provider: StorageProvider;
  path: string;
  capabilities?: Capabilities | undefined;
  ancestors: readonly EntryRef[];
}): CurrentDirectoryContextValue {
  const canWrite = capabilities?.write?.support !== 'unsupported';
  const canCreateDirectory = capabilities?.createDirectory?.support !== 'unsupported';
  const canUpload = provider !== 'local' && canWrite;
  const canUploadFolder = canUpload && canCreateDirectory;
  const canDropLocalFiles = canWrite;

  return {
    ref,
    provider,
    path,
    capabilities,
    ancestors,
    canWrite,
    canCreateDirectory,
    canUpload,
    canUploadFolder,
    canDropLocalFiles,
  };
}

export const CurrentDirectoryContext = createContext<CurrentDirectoryContextValue | null>(null);

export function useCurrentDirectory(): CurrentDirectoryContextValue {
  const directory = useContext(CurrentDirectoryContext);
  if (!directory) throw new Error('CurrentDirectoryContext is not configured.');
  return directory;
}
