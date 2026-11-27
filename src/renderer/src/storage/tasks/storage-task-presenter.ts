import type {
  TaskGroupPresenter,
  TaskPresenter,
  TaskRowModel,
} from '@renderer/tasks/task-row-model';
import type { RenameTaskRequest, StorageTaskGroupItem, StorageTaskItem } from '@shared/tasks';

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
    case 'transfer': {
      const input = task.request.input;
      const typeLabelKey = resolveTransferTypeLabel(
        input.mode,
        input.sourceProvider,
        input.targetProvider,
      );
      return {
        typeLabel: { key: typeLabelKey },
        title: [{ text: input.displayName ?? input.targetName }],
        summary: `${input.sourceDirectoryPath} → ${input.targetDirectoryPath}`,
        ...(task.status === 'skipped'
          ? { resultMessage: { key: 'errors:unsupported' as const } }
          : {}),
      };
    }
    case 'cleanup-move-source': {
      const input = task.request.input;
      return {
        typeLabel: { key: 'storage:moveTask' },
        ...presentGroupTitle(input.names),
        summary: `${input.sourceDirectoryPath} → ${input.targetDirectoryPath}`,
      };
    }
  }
};

function resolveTransferTypeLabel(
  mode: 'copy' | 'move',
  sourceProvider: string,
  targetProvider: string,
): string {
  if (mode === 'move') return 'storage:moveTask';
  if (sourceProvider === 'local' && targetProvider !== 'local') return 'storage:uploadTask';
  if (sourceProvider !== 'local' && targetProvider === 'local') return 'storage:downloadEntry';
  return 'storage:copyTask';
}

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
    case 'transfer': {
      const input = group.request.input;
      return {
        typeLabel: {
          key: resolveTransferTypeLabel(input.mode, input.sourceProvider, input.targetProvider),
        },
        ...presentGroupTitle(input.names),
        summary: `${input.sourcePath} → ${input.destinationPath}`,
      };
    }
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
