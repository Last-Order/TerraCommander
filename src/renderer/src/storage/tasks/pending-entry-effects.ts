import type { Entry, EntryRef } from '../../../../shared/storage';
import { isFinishedTask } from '../../tasks/task-selectors';
import { directoryKey } from '../directory/directory-cache';
import type { StorageTaskGroupItem, StorageTaskItem } from './storage-task-types';

export interface PendingEntryEffect {
  busy: boolean;
  optimisticName?: string;
}

export function selectPendingEntryEffects(
  tasks: readonly StorageTaskItem[],
  groups: readonly StorageTaskGroupItem[],
  entries: ReadonlyMap<string, Entry>,
  parent: EntryRef,
): ReadonlyMap<string, PendingEntryEffect> {
  const effects = new Map<string, PendingEntryEffect>();
  const parentKey = directoryKey(parent);
  for (const task of tasks) {
    if (isFinishedTask(task)) continue;
    switch (task.request.type) {
      case 'rename': {
        const { input } = task.request;
        if (directoryKey(input.parent) === parentKey)
          effects.set(input.entry.ref.locator, { busy: true, optimisticName: input.name });
        break;
      }
      case 'delete':
      case 'download': {
        const { input } = task.request;
        if (directoryKey(input.parent) === parentKey)
          effects.set(input.entry.ref.locator, { busy: true });
        break;
      }
    }
  }
  const resources = new Set<string>();
  for (const group of groups) {
    if (group.state.phase === 'settled') continue;
    for (const resource of group.request.resources ?? []) resources.add(resource);
  }
  if (resources.size > 0) {
    for (const entry of entries.values()) {
      if (!resources.has(directoryKey(entry.ref))) continue;
      const existing = effects.get(entry.ref.locator);
      effects.set(
        entry.ref.locator,
        existing?.optimisticName !== undefined
          ? { busy: true, optimisticName: existing.optimisticName }
          : { busy: true },
      );
    }
  }
  return effects;
}
