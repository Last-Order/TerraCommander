import type { Entry } from '../../../../shared/storage';
import type { TaskHandler } from '../../tasks/task-types';
import { directoryKey, type DirectoryCache } from '../directory/directory-cache';
import { errorKey, resultOf } from '../storage-client';
import type { RenameTaskInput } from './storage-task-types';

export function createRenameTaskHandler({
  directoryCache,
  onAuthRequired,
}: {
  directoryCache: DirectoryCache;
  onAuthRequired: () => void;
}): TaskHandler<RenameTaskInput, Entry> {
  return {
    conflictKeys: ({ entry }) => [directoryKey(entry.ref)],
    execute: ({ entry, name }) => resultOf(window.desktop.storage.renameEntry(entry.ref, name)),
    onSuccess: ({ parent, entry }, result) => {
      try {
        directoryCache.rename({ parent, previous: entry.ref, entry: result });
      } catch {
        console.error('Could not apply the rename result; invalidating the directory cache.');
        directoryCache.invalidateConnection(parent.connectionId);
      }
    },
    toFailure: (error) => {
      const code = errorKey(error);
      return {
        code,
        message: {
          key: code === 'InvalidArgument' ? 'storage:invalidEntryName' : `errors:${code}`,
        },
      };
    },
    onFailure: (_input, failure) => {
      if (failure.code === 'AuthRequired') onAuthRequired();
    },
  };
}
