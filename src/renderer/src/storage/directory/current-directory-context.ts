import { createContext, useContext } from 'react';
import type { Capabilities, EntryRef } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';

export interface CurrentDirectoryContextValue {
  ref: EntryRef;
  path: string;
  capabilities?: Capabilities | undefined;
  ancestors: readonly EntryRef[];
  isLocal: boolean;
  isRoot: boolean;
  canWrite: boolean;
  canCreateDirectory: boolean;
  canUpload: boolean;
  canUploadFolder: boolean;
  allowsDuplicateNames: boolean;
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
  const isRoot = ancestors.length <= 1;
  const canWrite = capabilities?.write?.support !== 'unsupported';
  const canCreateDirectory = capabilities?.createDirectory?.support !== 'unsupported';
  const canUpload = !isLocal && canWrite;
  const canUploadFolder = canUpload && canCreateDirectory;
  const allowsDuplicateNames =
    capabilities?.write?.guarantees?.allowsDuplicateNames === true ||
    capabilities?.createDirectory?.guarantees?.allowsDuplicateNames === true;

  return {
    ref,
    path,
    capabilities,
    ancestors,
    isLocal,
    isRoot,
    canWrite,
    canCreateDirectory,
    canUpload,
    canUploadFolder,
    allowsDuplicateNames,
  };
}

export const CurrentDirectoryContext = createContext<CurrentDirectoryContextValue | null>(null);

export function useCurrentDirectory(): CurrentDirectoryContextValue {
  const directory = useContext(CurrentDirectoryContext);
  if (!directory) throw new Error('CurrentDirectoryContext is not configured.');
  return directory;
}
