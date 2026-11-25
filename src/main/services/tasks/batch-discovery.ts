import type { TaskDefinitions, TaskGroupPreparationContext } from '@main/tasks/types';
import type { BrowserErrorCode } from '@shared/storage-browser';
import { toBrowserErrorCode, toTaskFailure } from './task-errors';

export interface BatchDirectoryPage<TItem> {
  items: TItem[];
  nextOffset?: number;
}

export interface BatchDiscoveryConfig<TItem, TDefinitions extends TaskDefinitions> {
  initialItems: readonly TItem[];
  getItemId: (item: TItem) => number;
  getItemLabel: (item: TItem) => string;
  isDirectory: (item: TItem) => boolean;
  discoverDirectory: (itemId: number, offset: number) => Promise<BatchDirectoryPage<TItem>>;
  cancelDirectoryItem: (itemId: number) => Promise<void>;
  cancelErrorMessage: string;
  fatalErrorCodes: ReadonlySet<BrowserErrorCode>;
  enqueueFile: (
    item: TItem,
    context: TaskGroupPreparationContext<TDefinitions>,
  ) => Promise<boolean | void>;
  beforeDirectory?: (item: TItem, context: TaskGroupPreparationContext<TDefinitions>) => boolean;
  afterDirectory?: () => void;
}

/** Runs stack-based DFS discovery and backpressure-aware enqueueing for a transfer batch. */
export async function prepareBatchGroup<TItem, TDefinitions extends TaskDefinitions>(
  config: BatchDiscoveryConfig<TItem, TDefinitions>,
  context: TaskGroupPreparationContext<TDefinitions>,
): Promise<void> {
  const pending = [...config.initialItems].reverse();
  let activeDirectory: TItem | undefined;

  const cancelDirectory = () => {
    if (!activeDirectory) return;
    void config.cancelDirectoryItem(config.getItemId(activeDirectory)).catch(() => {
      console.error(config.cancelErrorMessage);
    });
  };
  context.signal.addEventListener('abort', cancelDirectory, { once: true });

  const enqueueFile = async (item: TItem) => {
    await config.enqueueFile(item, context);
  };

  const discoverDirectory = async (item: TItem) => {
    let offset: number | undefined = 0;
    const itemId = config.getItemId(item);
    while (offset !== undefined && !context.signal.aborted) {
      const page = await config.discoverDirectory(itemId, offset);
      for (const child of page.items) {
        if (context.signal.aborted) break;
        if (config.isDirectory(child)) pending.push(child);
        else await enqueueFile(child);
      }
      offset = page.nextOffset;
    }
  };

  const prepareDirectory = async (item: TItem) => {
    if (config.beforeDirectory && !config.beforeDirectory(item, context)) return;
    activeDirectory = item;
    try {
      await discoverDirectory(item);
    } catch (error) {
      if (context.signal.aborted || config.fatalErrorCodes.has(toBrowserErrorCode(error))) {
        throw error;
      }
      context.reportIssue({ label: config.getItemLabel(item), failure: toTaskFailure(error) });
    } finally {
      activeDirectory = undefined;
      config.afterDirectory?.();
    }
  };

  try {
    while (pending.length && !context.signal.aborted) {
      const item = pending.pop()!;
      if (config.isDirectory(item)) await prepareDirectory(item);
      else await enqueueFile(item);
    }
  } finally {
    context.signal.removeEventListener('abort', cancelDirectory);
  }
}
