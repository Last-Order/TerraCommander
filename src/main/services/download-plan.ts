import { dirname, join } from 'node:path';
import type { DownloadPlanItem, DownloadPlanPage } from './download-types';
import type { Entry, EntryRef } from '../../shared/storage';
import { StorageError, throwIfAborted } from '../storage/core/errors';
import { DownloadDirectories } from './download-directories';
import { allocateDownloadNames } from './download-names';
import { DownloadError, validateDownloadName } from './download-paths';
import { DownloadTransfer, type DownloadSource } from './download-transfer';

export interface DownloadPlanRoot {
  entry: Entry;
  name: string;
  replace: boolean;
}

interface PlanNode extends Omit<DownloadPlanItem, 'targetPath'> {
  target: string;
  name: string;
  replace: boolean;
  ancestors: readonly string[];
  cancelled: boolean;
  children?: PlanNode[];
}

function refKey({ ref: { connectionId, spaceId, locator } }: Entry): string {
  return JSON.stringify([connectionId, spaceId, locator]);
}

/** Owns paths and discovery snapshots; each operation is scheduled by the renderer queue. */
export class DownloadPlan {
  private readonly directories = new DownloadDirectories();
  private readonly nodes: PlanNode[] = [];
  private readonly operations = new Map<number, AbortController>();
  private readonly discovery = new Map<number, Promise<PlanNode[]>>();
  private initialization: Promise<void> | undefined;
  private released = false;
  private finished = false;
  readonly roots: DownloadPlanItem[];

  constructor(
    private readonly source: DownloadSource,
    readonly directory: string,
    roots: readonly DownloadPlanRoot[],
    private confirmed: boolean,
    private readonly discover: (entry: Entry) => void,
  ) {
    this.roots = roots.map((root) =>
      this.snapshot(this.add(root.entry, root.name, '', root.replace, [])),
    );
  }

  confirm(): void {
    this.assertUsable();
    this.confirmed = true;
  }

  async directoryPage(itemId: number, offset: number): Promise<DownloadPlanPage> {
    const node = this.node(itemId);
    this.assertConfirmed();
    if (node.entry.kind !== 'directory') throw new StorageError('InvalidArgument');
    let pending = this.discovery.get(itemId);
    if (!pending) {
      pending = this.discoverDirectory(node);
      this.discovery.set(itemId, pending);
      void pending.finally(() => this.discovery.delete(itemId)).catch(() => {});
    }
    const children = await pending;
    const items = children.slice(offset, offset + 32).map((child) => this.snapshot(child));
    return {
      items,
      ...(offset + items.length < children.length ? { nextOffset: offset + items.length } : {}),
    };
  }

  async prepareFile(
    itemId: number,
  ): Promise<{ path: string; entry: Entry; transfer: DownloadTransfer }> {
    const node = this.node(itemId);
    this.assertConfirmed();
    if (node.entry.kind !== 'file' || node.entry.capabilities.read?.support === 'unsupported')
      throw new StorageError('Unsupported');
    const controller = this.begin(node);
    try {
      await this.initialize();
      await this.directories.assert(dirname(node.target));
      const current = await this.source.stat(node.entry.ref, { signal: controller.signal });
      throwIfAborted(controller.signal);
      this.node(itemId);
      if (
        current.kind !== 'file' ||
        current.name !== node.entry.name ||
        (node.entry.size !== undefined && current.size !== node.entry.size) ||
        (node.entry.revision !== undefined && current.revision !== node.entry.revision)
      )
        throw new StorageError('SourceChanged');
      return {
        path: node.target,
        entry: node.entry,
        transfer: new DownloadTransfer(
          this.source,
          {
            ref: node.entry.ref,
            expectedName: node.entry.name,
            directory: dirname(node.target),
            replace: node.replace,
          },
          dirname(node.target),
          node.target,
          node.entry,
          () => this.directories.assert(dirname(node.target)),
        ),
      };
    } finally {
      this.operations.delete(itemId);
    }
  }

  cancelItem(itemId: number): void {
    const node = this.nodes[itemId];
    if (!node) throw new StorageError('InvalidArgument');
    node.cancelled = true;
    this.operations.get(itemId)?.abort();
  }

  finish(): void {
    if (this.operations.size) throw new DownloadError('DownloadTargetBusy');
    this.finished = true;
  }

  reopen(): void {
    this.assertUsable();
    this.finished = false;
  }

  async release(): Promise<void> {
    this.released = true;
    for (const operation of this.operations.values()) operation.abort();
    await Promise.allSettled(this.discovery.values());
    if (!this.finished) await this.directories.cleanup();
  }

  private assertUsable(): void {
    if (this.released) throw new StorageError('Cancelled');
  }

  private assertConfirmed(): void {
    this.assertUsable();
    if (!this.confirmed) throw new StorageError('AlreadyExists');
  }

  private node(id: number): PlanNode {
    this.assertUsable();
    const node = this.nodes[id];
    if (!node) throw new StorageError('InvalidArgument');
    if (node.cancelled) throw new StorageError('Cancelled');
    if (node.code) throw new DownloadError('InvalidDownloadName');
    return node;
  }

  private begin(node: PlanNode): AbortController {
    if (this.operations.has(node.id)) throw new DownloadError('DownloadTargetBusy');
    const controller = new AbortController();
    this.operations.set(node.id, controller);
    return controller;
  }

  private async initialize(): Promise<void> {
    this.initialization ??= this.directories.initialize(this.directory).catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
    this.assertUsable();
  }

  private async discoverDirectory(node: PlanNode): Promise<PlanNode[]> {
    if (node.children) return node.children;
    if (!this.source.list || node.entry.capabilities.list?.support === 'unsupported')
      throw new StorageError('Unsupported');
    if (node.ancestors.includes(refKey(node.entry))) throw new StorageError('OutcomeUnknown');
    const controller = this.begin(node);
    try {
      await this.initialize();
      await this.directories.ensure(node.target, node.replace);
      const entries = new Map<string, Entry>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        throwIfAborted(controller.signal);
        const page = await this.source.list(
          node.entry.ref,
          { cursor },
          { signal: controller.signal },
        );
        throwIfAborted(controller.signal);
        for (const child of page.entries) {
          if (
            child.ref.connectionId !== node.entry.ref.connectionId ||
            child.ref.spaceId !== node.entry.ref.spaceId
          )
            throw new StorageError('OutcomeUnknown');
          entries.set(refKey(child), child);
        }
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) throw new StorageError('OutcomeUnknown');
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      this.node(node.id);
      const children = [...entries.values()];
      const names = allocateDownloadNames(children);
      node.children = children.map((entry, index) =>
        this.add(
          entry,
          names[index]!,
          node.path,
          node.replace,
          [...node.ancestors, refKey(node.entry)],
          node.entry.ref,
        ),
      );
      return node.children;
    } finally {
      this.operations.delete(node.id);
    }
  }

  private add(
    entry: Entry,
    name: string,
    parent: string,
    replace: boolean,
    ancestors: readonly string[],
    parentRef?: EntryRef,
  ): PlanNode {
    const path = join(parent, name);
    const node: PlanNode = {
      id: this.nodes.length,
      entry: structuredClone(entry),
      name,
      path,
      target: join(this.directory, path),
      replace,
      ancestors,
      cancelled: false,
      ...(parentRef ? { parent: parentRef } : {}),
    };
    try {
      validateDownloadName(entry.name);
      validateDownloadName(name);
    } catch {
      node.code = 'InvalidDownloadName';
    }
    this.nodes.push(node);
    this.discover(entry);
    return node;
  }

  private snapshot({ id, entry, path, target, code, parent }: PlanNode): DownloadPlanItem {
    return {
      id,
      entry: structuredClone(entry),
      path,
      targetPath: target,
      ...(code ? { code } : {}),
      ...(parent ? { parent: structuredClone(parent) } : {}),
    };
  }
}
