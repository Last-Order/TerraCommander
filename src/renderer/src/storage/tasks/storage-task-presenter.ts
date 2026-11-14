import type { TaskRowModel } from '../../tasks/task-row-model';
import type {
  DownloadTaskInput,
  RenameTaskInput,
  StorageTaskDefinitions,
} from './storage-task-types';
import type { QueueTask } from '../../tasks/task-types';

function presentRenameTask(input: RenameTaskInput): TaskRowModel {
  return {
    typeLabel: { key: 'storage:renameEntry' },
    title: [{ text: input.entry.name }, { text: '→', secondary: true }, { text: input.name }],
    summary: input.directoryPath,
  };
}

export const presentStorageTask = (
  task: QueueTask<StorageTaskDefinitions>,
  onRetry?: (input: DownloadTaskInput) => void,
): TaskRowModel => {
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
        actions:
          task.status === 'completed'
            ? [
                {
                  id: 'show',
                  label: { key: 'storage:showDownloadInFolder' },
                  onClick: () => {
                    void window.desktop.downloads.showInFolder(input.destination.id);
                  },
                },
              ]
            : (task.status === 'failed' || task.status === 'cancelled') && onRetry
              ? [
                  {
                    id: 'retry',
                    label: { key: 'common:retry' },
                    onClick: () => onRetry(input),
                  },
                ]
              : [],
      };
    }
  }
};
