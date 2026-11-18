import type { DownloadPlanItem, DownloadPlanPage } from '../../../../shared/downloads';
import type { TaskQueue } from '../../tasks/task-queue';
import type { TaskGroupPreparationContext } from '../../tasks/task-group-types';
import { directoryKey } from '../directory/directory-cache';
import { errorKey, resultOf, StorageBrowserError } from '../storage-client';
import type {
  DownloadGroupInput,
  StorageTaskDefinitions,
  StorageTaskGroupDefinitions,
} from './storage-task-types';

function failure(error: unknown) {
  const code = errorKey(error);
  return { code, message: { key: `errors:${code}` as const } };
}

async function prepareDownloads(
  input: DownloadGroupInput,
  context: TaskGroupPreparationContext<StorageTaskDefinitions>,
  onLocalChanged: () => void,
): Promise<void> {
  const pending = [...input.destination.items].reverse();
  let activeDirectory: DownloadPlanItem | undefined;
  let discoveredFiles = 0;
  let preparedFolders = 0;
  const enqueueFile = async (item: DownloadPlanItem) => {
    discoveredFiles++;
    const admitted = await context.enqueue(
      {
        type: 'download',
        input: {
          entry: item.entry,
          parent: item.parent ?? input.parent,
          directoryPath: input.directoryPath,
          displayName: item.path,
          destination: {
            ref: { planId: input.destination.id, itemId: item.id },
            path: item.targetPath,
          },
        },
      },
      `${input.destination.id}:${item.id}`,
    );
    if (!admitted && !context.signal.aborted)
      context.reportIssue({
        label: item.path,
        failure: failure(new StorageBrowserError('DownloadTargetBusy')),
      });
  };
  const cancelDirectory = () => {
    if (activeDirectory)
      void window.desktop.downloads
        .cancelBatchItem(input.destination.id, activeDirectory.id)
        .catch(() => {
          console.error('Download directory preparation cancellation failed.');
        });
  };
  context.signal.addEventListener('abort', cancelDirectory, { once: true });
  try {
    while (pending.length && !context.signal.aborted) {
      const item = pending.pop()!;
      if (item.entry.kind !== 'directory') {
        await enqueueFile(item);
      } else {
        activeDirectory = item;
        try {
          let offset: number | undefined = 0;
          while (offset !== undefined && !context.signal.aborted) {
            const page: DownloadPlanPage = await resultOf(
              window.desktop.downloads.discoverBatchDirectory(
                input.destination.id,
                item.id,
                offset,
              ),
            );
            for (const child of page.items) {
              if (context.signal.aborted) break;
              if (child.entry.kind === 'directory') pending.push(child);
              else await enqueueFile(child);
            }
            offset = page.nextOffset;
          }
          preparedFolders++;
        } catch (error) {
          const code = errorKey(error);
          if (
            context.signal.aborted ||
            code === 'AuthRequired' ||
            code === 'InsufficientSpace' ||
            code === 'InvalidDownloadDirectory'
          )
            throw error;
          context.reportIssue({ label: item.path, failure: failure(error) });
        } finally {
          activeDirectory = undefined;
          try {
            onLocalChanged();
          } catch {
            console.error('Download directory refresh failed.');
          }
        }
      }
      context.reportProgress({
        kind: 'indeterminate',
        stage: { key: 'storage:downloadScanning' },
        summary: {
          key: 'storage:downloadPreparationProgress',
          values: { discoveredFiles, preparedFolders },
        },
      });
    }
  } finally {
    context.signal.removeEventListener('abort', cancelDirectory);
  }
}

export function enqueueDownloadGroup(
  queue: TaskQueue<StorageTaskDefinitions, StorageTaskGroupDefinitions>,
  input: DownloadGroupInput,
  options: { onAuthRequired: () => void; onLocalChanged: () => void },
): boolean {
  const { destination, entries, directoryPath } = input;
  return (
    queue.createGroup(
      {
        kind: 'download',
        input: {
          names: entries.map((entry) => entry.name),
          sourcePath: directoryPath,
          destinationPath: destination.path,
        },
        resources: entries.map((entry) => directoryKey(entry.ref)),
      },
      {
        prepare: (context) => prepareDownloads(input, context, options.onLocalChanged),
        toFailure: failure,
        onPreparationFailure: (error) => {
          if (error.code === 'AuthRequired') options.onAuthRequired();
        },
        onSettled: () => resultOf(window.desktop.downloads.finishBatch(destination.id)),
        release: () => resultOf(window.desktop.downloads.releaseBatch(destination.id)),
      },
    ) !== undefined
  );
}
