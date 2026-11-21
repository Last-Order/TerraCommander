import type { Entry, EntryRef } from '@shared/storage';
import { isFinishedTask } from '@renderer/tasks/task-selectors';
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
      case 'move': {
        const { input } = task.request;
        if (directoryKey(input.sourceParent) === parentKey)
          effects.set(input.entry.ref.locator, { busy: true });
        break;
      }
      case 'upload': {
        for (const ref of task.request.input.sourceEntries ?? []) {
          if (
            ref.connectionId === parent.connectionId &&
            ref.spaceId === parent.spaceId &&
            entries.has(ref.locator)
          ) {
            effects.set(ref.locator, { busy: true });
          }
        }
        break;
      }
    }
  }
  for (const group of groups) {
    if (group.state.phase === 'settled') continue;
    let groupEntries: readonly EntryRef[] | undefined;
    if (
      group.request.kind === 'download' ||
      group.request.kind === 'delete' ||
      group.request.kind === 'move'
    ) {
      groupEntries = group.request.input.entries;
    } else if (group.request.kind === 'upload') {
      groupEntries = group.request.input.sourceEntries;
    } else {
      continue;
    }
    for (const ref of groupEntries ?? []) {
      if (
        ref.connectionId !== parent.connectionId ||
        ref.spaceId !== parent.spaceId ||
        !entries.has(ref.locator)
      ) {
        continue;
      }
      const existing = effects.get(ref.locator);
      effects.set(
        ref.locator,
        existing?.optimisticName !== undefined
          ? { busy: true, optimisticName: existing.optimisticName }
          : { busy: true },
      );
    }
  }
  return effects;
}
