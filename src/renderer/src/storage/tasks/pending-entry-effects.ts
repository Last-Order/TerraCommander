import type { EntryRef } from '../../../../shared/storage';
import { isActiveTask } from '../../tasks/task-selectors';
import type { QueueTask } from '../../tasks/task-types';
import { directoryKey } from '../directory/directory-cache';
import type { StorageTaskDefinitions } from './storage-task-types';

interface PendingEntryEffect {
  busy: boolean;
  optimisticName?: string;
}

export function selectPendingEntryEffects(
  tasks: readonly QueueTask<StorageTaskDefinitions>[],
  parent: EntryRef,
): ReadonlyMap<string, PendingEntryEffect> {
  const effects = new Map<string, PendingEntryEffect>();
  const parentKey = directoryKey(parent);
  for (const task of tasks) {
    if (!isActiveTask(task)) continue;
    switch (task.request.type) {
      case 'rename': {
        const { input } = task.request;
        if (directoryKey(input.parent) === parentKey)
          effects.set(input.entry.ref.locator, { busy: true, optimisticName: input.name });
        break;
      }
      case 'delete': {
        const { input } = task.request;
        if (directoryKey(input.parent) === parentKey)
          effects.set(input.entry.ref.locator, { busy: true });
        break;
      }
    }
  }
  return effects;
}
