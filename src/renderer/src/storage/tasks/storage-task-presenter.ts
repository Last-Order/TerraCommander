import type { TaskRowModel, TaskGroupPresenter } from '../../tasks/task-row-model';
import type {
  RenameTaskInput,
  StorageTaskDefinitions,
  StorageTaskGroupDefinitions,
} from './storage-task-types';
import type { QueueTask } from '../../tasks/task-types';

function presentRenameTask(input: RenameTaskInput): TaskRowModel {
  return {
    typeLabel: { key: 'storage:renameEntry' },
    title: [{ text: input.entry.name }, { text: '→', secondary: true }, { text: input.name }],
    summary: input.directoryPath,
  };
}

export const presentStorageTask = (task: QueueTask<StorageTaskDefinitions>): TaskRowModel => {
  switch (task.request.type) {
    case 'rename':
      return presentRenameTask(task.request.input);
    case 'delete':
      return {
        typeLabel: { key: 'storage:deleteEntry' },
        title: [{ text: task.request.input.entry.name }],
        summary: task.request.input.directoryPath,
      };
    case 'download': {
      const input = task.request.input;
      return {
        compact: true,
        typeLabel: { key: 'storage:downloadEntry' },
        title: [{ text: input.displayName ?? input.entry.name }],
        summary: `${input.directoryPath} → ${input.destination.path}`,
        ...(task.status === 'skipped'
          ? { resultMessage: { key: 'errors:Unsupported' as const } }
          : {}),
      };
    }
  }
};

export const presentStorageTaskGroup: TaskGroupPresenter<StorageTaskGroupDefinitions> = (group) => {
  const input = group.request.input;
  return {
    typeLabel: { key: 'storage:downloadEntry' },
    title: input.names.slice(0, 3).map((name) => ({ text: name })),
    summary: `${input.sourcePath} → ${input.destinationPath}`,
  };
};
