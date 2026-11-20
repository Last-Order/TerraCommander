import { dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { channels } from '@shared/contracts';
import { localConnectionId } from '@shared/storage-browser';
import type { TrustedIpc } from './helpers';
import { isTrustedRenderer } from '../security';
import type { ApplicationServices } from '../services/application-services';
import type { StorageTaskService } from '../services/tasks/storage-task-service';
import { entryNameSchema, entryRefSchema, entrySchema } from '../storage/core/validation';

const connectionId = z.union([z.literal(localConnectionId), z.uuid()]);
const refSchema = entryRefSchema.extend({
  connectionId,
  spaceId: z.string().min(1).max(1024),
  locator: z.string().min(1).max(32_768),
});
const remoteRefSchema = refSchema.extend({ connectionId: z.uuid() });
const taskEntrySchema = entrySchema.extend({
  ref: refSchema,
  name: z.string().min(1).max(32_768),
});
const downloadEntrySchema = entrySchema.extend({
  ref: remoteRefSchema,
  name: z.string().min(1).max(32_768),
});
const pathSchema = z
  .string()
  .max(32_768)
  .refine((path) => !path.includes('\0'));
const noArguments = z.tuple([]);
const taskIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const confirmationIdSchema = z.uuid();

const renameRequestSchema = z.strictObject({
  parent: refSchema,
  entry: taskEntrySchema,
  name: entryNameSchema,
  directoryPath: pathSchema,
});

const deleteRequestSchema = z.strictObject({
  parent: refSchema,
  entry: taskEntrySchema,
  directoryPath: pathSchema,
});

const uploadFileSchema = z.strictObject({ parent: remoteRefSchema, directoryPath: pathSchema });

const prepareDownloadSchema = z.strictObject({
  parent: remoteRefSchema,
  entries: z.array(downloadEntrySchema).min(1),
  directory: pathSchema,
  directoryPath: pathSchema,
});

export function registerTaskIpc(
  ipc: TrustedIpc,
  entryUrl: string,
  services: ApplicationServices,
): void {
  const observed = new WeakMap<StorageTaskService, Set<number>>();

  async function getTasks(window: BrowserWindow): Promise<StorageTaskService> {
    const tasks = await services.tasks.get();
    if (
      window.webContents.isDestroyed() ||
      !isTrustedRenderer(window.webContents.mainFrame.url, entryUrl)
    ) {
      throw new Error('Renderer session closed');
    }
    let owners = observed.get(tasks);
    if (!owners) {
      owners = new Set();
      observed.set(tasks, owners);
    }
    const owner = window.webContents.id;
    if (!owners.has(owner)) {
      owners.add(owner);
      const unsubscribe = tasks.subscribe((event) => {
        try {
          if (
            !window.webContents.isDestroyed() &&
            isTrustedRenderer(window.webContents.mainFrame.url, entryUrl)
          ) {
            window.webContents.send(channels.taskEvent, event);
          }
        } catch {
          // Renderer frame may close while a main-process task event is emitting.
        }
      });
      ipc.observeRendererSession(window, (id) => tasks.cancelOwnerConfirmations(id));
      window.webContents.once('destroyed', () => {
        unsubscribe();
        owners.delete(owner);
      });
    }
    return tasks;
  }

  function handleTask<A extends unknown[], T>(
    channel: string,
    schema: z.ZodType<A>,
    run: (tasks: StorageTaskService, window: BrowserWindow, ...args: A) => T | Promise<T>,
  ): void {
    ipc.handle(channel, schema, async (window, ...args) =>
      run(await getTasks(window), window, ...args),
    );
  }

  handleTask(channels.getTaskSnapshot, noArguments, (tasks) => tasks.getSnapshot());
  handleTask(
    channels.enqueueRenameTask,
    z.tuple([renameRequestSchema]),
    (tasks, _window, request) => tasks.enqueueRename(request),
  );
  handleTask(
    channels.enqueueDeleteTask,
    z.tuple([deleteRequestSchema]),
    (tasks, _window, request) => tasks.enqueueDelete(request),
  );
  handleTask(channels.uploadFileTask, z.tuple([uploadFileSchema]), (tasks, window, request) =>
    tasks.uploadPaths(window.webContents.id, request, async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'multiSelections'],
      });
      return result.canceled ? [] : result.filePaths;
    }),
  );
  handleTask(channels.uploadFolderTask, z.tuple([uploadFileSchema]), (tasks, window, request) =>
    tasks.uploadPaths(
      window.webContents.id,
      request,
      async () => {
        const result = await dialog.showOpenDialog(window, {
          properties: ['openDirectory', 'multiSelections'],
        });
        return result.canceled ? [] : result.filePaths;
      },
      { requireCreateDirectory: true },
    ),
  );
  handleTask(
    channels.prepareDownloadTask,
    z.tuple([prepareDownloadSchema]),
    (tasks, window, request) => tasks.prepareDownload(window.webContents.id, request),
  );
  handleTask(
    channels.confirmDownloadTask,
    z.tuple([confirmationIdSchema]),
    (tasks, window, confirmationId) => tasks.confirmDownload(window.webContents.id, confirmationId),
  );
  handleTask(
    channels.cancelDownloadConfirmation,
    z.tuple([confirmationIdSchema]),
    (tasks, window, confirmationId) =>
      tasks.cancelDownloadConfirmation(window.webContents.id, confirmationId),
  );
  handleTask(channels.pauseTask, z.tuple([taskIdSchema]), (tasks, _window, taskId) =>
    tasks.pause(taskId),
  );
  handleTask(channels.resumeTask, z.tuple([taskIdSchema]), (tasks, _window, taskId) =>
    tasks.resume(taskId),
  );
  handleTask(channels.cancelTask, z.tuple([taskIdSchema]), (tasks, _window, taskId) =>
    tasks.cancel(taskId),
  );
  handleTask(channels.retryTask, z.tuple([taskIdSchema]), (tasks, _window, taskId) =>
    tasks.retry(taskId),
  );
  handleTask(channels.clearFinishedTasks, noArguments, (tasks) => tasks.clearFinished());
}
