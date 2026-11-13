import type { TaskHandler } from '../../tasks/task-types';
import { directoryKey, type DirectoryCache } from '../directory/directory-cache';
import { errorKey, resultOf } from '../storage-client';
import type { DeleteTaskInput } from './storage-task-types';

export function createDeleteTaskHandler({
  directoryCache,
  onAuthRequired,
}: {
  directoryCache: DirectoryCache;
  onAuthRequired: () => void;
}): TaskHandler<DeleteTaskInput, void> {
  return {
    conflictKeys: ({ entry }) => [directoryKey(entry.ref)],
    execute: ({ entry }) => resultOf(window.desktop.storage.deleteEntry(entry.ref)),
    onSuccess: ({ parent, entry }) => {
      try {
        directoryCache.remove({ parent, ref: entry.ref });
      } catch {
        console.error('Could not apply the deletion result; invalidating the directory cache.');
        directoryCache.invalidateConnection(parent.connectionId);
      }
    },
    toFailure: (error) => {
      const code = errorKey(error);
      return { code, message: { key: `errors:${code}` } };
    },
    onFailure: (_input, failure) => {
      if (failure.code === 'AuthRequired') onAuthRequired();
    },
  };
}
