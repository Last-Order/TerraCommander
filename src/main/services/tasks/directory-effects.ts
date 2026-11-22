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
    | { type: 'delete' | 'download' | 'move'; input: { entry: { ref: EntryRef } } }
    | {
        type: 'upload';
        input: { display: { sourceEntries?: readonly EntryRef[] | undefined } };
      }
    | { type: 'create-directory' | 'copy'; input: unknown };
}

export interface DirectoryEffectGroup {
  state: TaskGroupState;
  request:
    | {
        kind: 'download' | 'delete' | 'move';
        input: { entries?: readonly EntryRef[] | undefined };
      }
    | {
        kind: 'upload';
        input: { sourceEntries?: readonly EntryRef[] | undefined };
      }
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
      case 'download':
      case 'move':
        markBusy(task.request.input.entry.ref);
        break;
      case 'upload':
        for (const ref of task.request.input.display.sourceEntries ?? []) markBusy(ref);
        break;
      case 'create-directory':
      case 'copy':
        break;
    }
  }

  for (const group of groups) {
    if (group.state.phase === 'settled') continue;
    switch (group.request.kind) {
      case 'download':
      case 'delete':
      case 'move':
        for (const ref of group.request.input.entries ?? []) markBusy(ref);
        break;
      case 'upload':
        for (const ref of group.request.input.sourceEntries ?? []) markBusy(ref);
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
