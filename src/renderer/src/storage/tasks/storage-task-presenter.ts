import type {
  TaskGroupPresenter,
  TaskPresenter,
  TaskRowModel,
} from '@renderer/tasks/task-row-model';
import type {
  RenameTaskRequest,
  StorageTaskGroupItem,
  StorageTaskItem,
} from './storage-task-types';

function presentRenameTask(input: RenameTaskRequest): TaskRowModel {
  return {
    typeLabel: { key: 'storage:renameEntry' },
    title: [{ text: input.entry.name }, { text: '→', secondary: true }, { text: input.name }],
    summary: input.directoryPath,
  };
}

export const presentStorageTask: TaskPresenter<StorageTaskItem> = (task) => {
  switch (task.request.type) {
    case 'rename':
      return presentRenameTask(task.request.input);
    case 'delete':
      return {
        typeLabel: { key: 'storage:deleteEntry' },
        title: [{ text: task.request.input.entry.name }],
        summary: task.request.input.directoryPath,
      };
    case 'upload':
      return {
        compact: true,
        typeLabel: { key: 'storage:uploadTask' },
        title: [{ text: task.request.input.displayName ?? task.request.input.name }],
        summary: task.request.input.directoryPath,
      };
    case 'download': {
      const input = task.request.input;
      return {
        compact: true,
        typeLabel: { key: 'storage:downloadEntry' },
        title: [{ text: input.displayName ?? input.entry.name }],
        summary: `${input.directoryPath} → ${input.destinationPath}`,
        ...(task.status === 'skipped'
          ? { resultMessage: { key: 'errors:Unsupported' as const } }
          : {}),
      };
    }
  }
};

export const presentStorageTaskGroup: TaskGroupPresenter<StorageTaskGroupItem> = (group) => {
  switch (group.request.kind) {
    case 'upload':
      return {
        typeLabel: { key: 'storage:uploadTask' },
        title: group.request.input.names.slice(0, 3).map((name) => ({ text: name })),
        summary: `${group.request.input.sourcePath} → ${group.request.input.destinationPath}`,
      };
    case 'download':
      return {
        typeLabel: { key: 'storage:downloadEntry' },
        title: group.request.input.names.slice(0, 3).map((name) => ({ text: name })),
        summary: `${group.request.input.sourcePath} → ${group.request.input.destinationPath}`,
      };
    case 'delete':
      return {
        typeLabel: { key: 'storage:deleteEntry' },
        title: group.request.input.names.slice(0, 3).map((name) => ({ text: name })),
        summary: group.request.input.directoryPath,
      };
  }
};
