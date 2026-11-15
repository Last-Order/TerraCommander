import type { TaskRowModel } from '../../tasks/task-row-model';
import type { RenameTaskInput, StorageTaskDefinitions } from './storage-task-types';
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
        typeLabel: { key: 'storage:downloadEntry' },
        title: [{ text: input.entry.name }],
        summary: `${input.directoryPath} → ${input.destination.path}`,
      };
    }
  }
};
