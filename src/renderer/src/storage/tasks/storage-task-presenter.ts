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
    case 'create-directory':
      return {
        typeLabel: { key: 'storage:newFolder' },
        title: [{ text: task.request.input.name }],
        summary: task.request.input.directoryPath,
      };
    case 'rename':
      return presentRenameTask(task.request.input);
    case 'delete':
      return {
        typeLabel: { key: 'storage:deleteEntry' },
        title: [{ text: task.request.input.entry.name }],
        summary: task.request.input.directoryPath,
      };
    case 'copy': {
      const input = task.request.input;
      return {
        typeLabel: { key: 'storage:copyTask' },
        title: [{ text: input.displayName ?? input.targetName }],
        summary: `${input.sourceDirectoryPath} → ${input.targetDirectoryPath}`,
      };
    }
    case 'move': {
      const input = task.request.input;
      return {
        typeLabel: { key: 'storage:moveTask' },
        title: [{ text: input.displayName ?? input.targetName }],
        summary: `${input.sourceDirectoryPath} → ${input.targetDirectoryPath}`,
      };
    }
    case 'upload':
      return {
        typeLabel: { key: 'storage:uploadTask' },
        title: [{ text: task.request.input.displayName ?? task.request.input.name }],
        summary: task.request.input.directoryPath,
      };
    case 'download': {
      const input = task.request.input;
      return {
        typeLabel: { key: 'storage:downloadEntry' },
        title: [{ text: input.displayName ?? input.entry.name }],
        summary: `${input.directoryPath} → ${input.destinationPath}`,
        ...(task.status === 'skipped'
          ? { resultMessage: { key: 'errors:unsupported' as const } }
          : {}),
      };
    }
  }
};

function presentGroupTitle(names: readonly string[]): Pick<TaskRowModel, 'title' | 'titleNote'> {
  return {
    title: names.slice(0, 1).map((name) => ({ text: name })),
    ...(names.length > 1
      ? { titleNote: { key: 'tasks:groupMoreEntries', values: { count: names.length - 1 } } }
      : {}),
  };
}

export const presentStorageTaskGroup: TaskGroupPresenter<StorageTaskGroupItem> = (group) => {
  switch (group.request.kind) {
    case 'upload':
      return {
        typeLabel: { key: 'storage:uploadTask' },
        ...presentGroupTitle(group.request.input.names),
        summary: `${group.request.input.sourcePath} → ${group.request.input.destinationPath}`,
      };
    case 'download':
      return {
        typeLabel: { key: 'storage:downloadEntry' },
        ...presentGroupTitle(group.request.input.names),
        summary: `${group.request.input.sourcePath} → ${group.request.input.destinationPath}`,
      };
    case 'delete':
      return {
        typeLabel: { key: 'storage:deleteEntry' },
        ...presentGroupTitle(group.request.input.names),
        summary: group.request.input.directoryPath,
      };
    case 'copy':
      return {
        typeLabel: { key: 'storage:copyTask' },
        ...presentGroupTitle(group.request.input.names),
        summary: `${group.request.input.sourcePath} → ${group.request.input.destinationPath}`,
      };
    case 'move':
      return {
        typeLabel: { key: 'storage:moveTask' },
        ...presentGroupTitle(group.request.input.names),
        summary: `${group.request.input.sourcePath} → ${group.request.input.destinationPath}`,
      };
  }
};
