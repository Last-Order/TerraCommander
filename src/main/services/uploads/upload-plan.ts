import type { BigIntStats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import type { Entry, EntryRef, StorageErrorCode } from '@shared/storage';
import type { StorageDirectory } from '../storage/storage-directory';
import { prepareLocalUpload } from './local-upload-source';
import type {
  ResolvedUploadWork,
  SameNameFolderPolicy,
  UploadPlanItem,
  UploadPlanPage,
} from './upload-types';

export interface UploadPlanRoot {
  kind: 'file' | 'directory';
  localPath: string;
  name: string;
  size: number;
  directory: StorageDirectory;
  identity?: string;
}

interface PlanNode extends UploadPlanItem {
  directory: StorageDirectory;
  destinationDirectory?: StorageDirectory;
  ancestors: readonly string[];
  cancelled: boolean;
  children?: PlanNode[];
}

function localStatError(error: unknown): never {
  if (error instanceof StorageError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    throw new StorageError('NotFound');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw new StorageError('PermissionDenied');
  }
  throw new StorageError('OutcomeUnknown', { cause: error });
}

function nodeIdentity(stat: BigIntStats, localPath: string): string {
  return stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : localPath;
}

/** Owns local discovery snapshots and retained destination folder IDs for an upload batch. */
export class UploadPlan {
  private readonly nodes: PlanNode[] = [];
  private readonly operations = new Map<number, AbortController>();
  private readonly discovery = new Map<number, Promise<PlanNode[]>>();
  private released = false;
  private finished = false;
  readonly roots: UploadPlanItem[];

  constructor(
    roots: readonly UploadPlanRoot[],
    readonly policy: SameNameFolderPolicy = 'create-new',
    private readonly onDirectoryCreated?: (parent: EntryRef, entry: Entry) => void,
  ) {
    this.roots = roots.map((root) =>
      this.snapshot(
        this.add({
          kind: root.kind,
          localPath: root.localPath,
          name: root.name,
          path: root.name,
          size: root.size,
          directory: root.directory,
          ancestors: root.identity ? [root.identity] : [],
        }),
      ),
    );
  }

  async directoryPage(itemId: number, offset: number): Promise<UploadPlanPage> {
    const node = this.node(itemId);
    this.assertUsable();
    if (node.kind !== 'directory') throw new StorageError('InvalidArgument');
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

  async prepareFile(itemId: number): Promise<ResolvedUploadWork> {
    const node = this.node(itemId);
    this.assertUsable();
    if (node.code) throw new StorageError(node.code);
    if (node.kind !== 'file') throw new StorageError('Unsupported');
    const controller = this.begin(node);
    try {
      const { source } = await prepareLocalUpload(node.localPath, node.name);
      throwIfAborted(controller.signal);
      this.node(itemId);
      const directory = node.directory;
      const name = node.name;
      return {
        parent: directory.ref,
        name,
        size: source.descriptor.size,
        prepare: () => directory.prepareUpload(name, source),
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
    if (this.operations.size) throw new StorageError('PreconditionFailed');
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
  }

  private assertUsable(): void {
    if (this.released) throw new StorageError('Cancelled');
  }

  private node(itemId: number): PlanNode {
    const node = this.nodes[itemId];
    if (!node || node.cancelled || this.released) throw new StorageError('Cancelled');
    return node;
  }

  private begin(node: PlanNode): AbortController {
    this.assertUsable();
    if (this.finished) throw new StorageError('InvalidArgument');
    const controller = new AbortController();
    this.operations.set(node.id, controller);
    return controller;
  }

  private async discoverDirectory(node: PlanNode): Promise<PlanNode[]> {
    if (node.children) return node.children;
    const controller = this.begin(node);
    try {
      const destinationDirectory = await this.ensureRemoteDirectory(node, controller.signal);
      const names = await readdir(node.localPath).catch((error: unknown) => localStatError(error));
      names.sort((left, right) => left.localeCompare(right));
      const children: PlanNode[] = [];
      for (const name of names) {
        throwIfAborted(controller.signal);
        this.node(node.id);
        const childPath = join(node.localPath, name);
        const displayPath = `${node.path}/${name}`;
        let stat: BigIntStats;
        try {
          stat = await lstat(childPath, { bigint: true }).catch((error: unknown) =>
            localStatError(error),
          );
        } catch (error) {
          const code = error instanceof StorageError ? error.code : 'OutcomeUnknown';
          children.push(
            this.add({
              kind: 'file',
              localPath: childPath,
              name,
              path: displayPath,
              size: 0,
              directory: destinationDirectory,
              ancestors: node.ancestors,
              code,
            }),
          );
          continue;
        }
        if (stat.isDirectory()) {
          const identity = nodeIdentity(stat, childPath);
          if (node.ancestors.includes(identity)) {
            children.push(
              this.add({
                kind: 'directory',
                localPath: childPath,
                name,
                path: displayPath,
                size: 0,
                directory: destinationDirectory,
                ancestors: node.ancestors,
                code: 'Unsupported',
              }),
            );
            continue;
          }
          children.push(
            this.add({
              kind: 'directory',
              localPath: childPath,
              name,
              path: displayPath,
              size: 0,
              directory: destinationDirectory,
              ancestors: [...node.ancestors, identity],
            }),
          );
        } else if (stat.isFile() && stat.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
          children.push(
            this.add({
              kind: 'file',
              localPath: childPath,
              name,
              path: displayPath,
              size: Number(stat.size),
              directory: destinationDirectory,
              ancestors: node.ancestors,
            }),
          );
        } else {
          children.push(
            this.add({
              kind: 'file',
              localPath: childPath,
              name,
              path: displayPath,
              size: 0,
              directory: destinationDirectory,
              ancestors: node.ancestors,
              code: 'Unsupported',
            }),
          );
        }
      }
      node.children = children;
      return children;
    } finally {
      this.operations.delete(node.id);
    }
  }

  private async ensureRemoteDirectory(
    node: PlanNode,
    signal: AbortSignal,
  ): Promise<StorageDirectory> {
    if (node.destinationDirectory) return node.destinationDirectory;
    const created = await node.directory.createDirectory(node.name, { signal });
    node.destinationDirectory = created.directory;
    this.onDirectoryCreated?.(node.directory.ref, created.entry);
    return created.directory;
  }

  private add(options: {
    kind: 'file' | 'directory';
    localPath: string;
    name: string;
    path: string;
    size: number;
    directory: StorageDirectory;
    ancestors: readonly string[];
    code?: StorageErrorCode;
  }): PlanNode {
    const node: PlanNode = {
      id: this.nodes.length,
      kind: options.kind,
      path: options.path,
      localPath: options.localPath,
      name: options.name,
      size: options.size,
      parent: options.directory.ref,
      directory: options.directory,
      ancestors: options.ancestors,
      cancelled: false,
      ...(options.code ? { code: options.code } : {}),
    };
    this.nodes.push(node);
    return node;
  }

  private snapshot(node: PlanNode): UploadPlanItem {
    return {
      id: node.id,
      kind: node.kind,
      path: node.path,
      localPath: node.localPath,
      name: node.name,
      size: node.size,
      parent: node.parent,
      ...(node.code ? { code: node.code } : {}),
    };
  }
}
