import type { TaskPresenter, TaskRowModel } from '../../tasks/task-row-model';
import type { RenameTaskInput, StorageTaskDefinitions } from './storage-task-types';

function presentRenameTask(input: RenameTaskInput): TaskRowModel {
  return {
    typeLabel: { key: 'storage:renameEntry' },
    title: [{ text: input.entry.name }, { text: '→', secondary: true }, { text: input.name }],
    summary: input.directoryPath,
  };
}

export const presentStorageTask: TaskPresenter<StorageTaskDefinitions> = (task) => {
  switch (task.request.type) {
    case 'rename':
      return presentRenameTask(task.request.input);
  }
};
