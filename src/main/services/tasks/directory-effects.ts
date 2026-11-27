import { entryKey, type EntryRef } from '@shared/storage';
import { isFinishedTask } from '@shared/task-selectors';
import type {
  PendingEntryRename,
  RenameTaskRequest,
  StorageDirectoryEffects,
  TaskGroupState,
  TaskStatus,
} from '@shared/tasks';

export interface DirectoryEffectTask {
  status: TaskStatus;
  request:
    | { type: 'rename'; input: Pick<RenameTaskRequest, 'parent' | 'entry' | 'name'> }
    | { type: 'delete' | 'move'; input: { entry: { ref: EntryRef } } }
    | {
        type: 'copy';
        input: { entry: { ref: EntryRef }; removeSourceAfterCopy?: boolean | undefined };
      }
    | { type: 'transfer'; input: { display: { entry: { ref: EntryRef } } } }
    | { type: 'cleanup-move-source'; input: { display: { entries: readonly EntryRef[] } } }
    | { type: 'create-directory'; input: unknown };
}

export interface DirectoryEffectGroup {
  state: TaskGroupState;
  request:
    | { kind: 'delete' | 'move'; input: { entries: readonly EntryRef[] } }
    | { kind: 'transfer'; input: { sourceEntries: readonly EntryRef[] } }
    | { kind: 'copy'; input: unknown };
}

/** Projects active tasks and groups into authoritative entry locks and optimistic renames. */
export function projectDirectoryEffects(
  tasks: readonly DirectoryEffectTask[],
  groups: readonly DirectoryEffectGroup[],
): StorageDirectoryEffects {
  const busyByKey = new Map<string, EntryRef>();
  const renames: PendingEntryRename[] = [];
  const markBusy = (ref: EntryRef) => {
    const key = entryKey(ref);
    if (!busyByKey.has(key)) busyByKey.set(key, ref);
  };

  for (const task of tasks) {
    if (isFinishedTask(task)) continue;
    switch (task.request.type) {
      case 'rename': {
        const { parent, entry, name } = task.request.input;
        markBusy(entry.ref);
        renames.push({ parent, entry: entry.ref, name });
        break;
      }
      case 'delete':
      case 'move':
        markBusy(task.request.input.entry.ref);
        break;
      case 'copy':
        if (task.request.input.removeSourceAfterCopy) {
          markBusy(task.request.input.entry.ref);
        }
        break;
      case 'transfer':
        markBusy(task.request.input.display.entry.ref);
        break;
      case 'cleanup-move-source':
        for (const ref of task.request.input.display.entries) markBusy(ref);
        break;
      case 'create-directory':
        break;
    }
  }

  for (const group of groups) {
    if (group.state.phase === 'settled') continue;
    switch (group.request.kind) {
      case 'delete':
      case 'move':
        for (const ref of group.request.input.entries) markBusy(ref);
        break;
      case 'transfer':
        for (const ref of group.request.input.sourceEntries) markBusy(ref);
        break;
      case 'copy':
        break;
    }
  }

  return {
    busyEntries: [...busyByKey.values()],
    renames,
  };
}
