import type { DirectoryScope } from '@main/storage/core/contracts';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import {
  entryKey,
  type Capabilities,
  type Entry,
  type EntryRef,
  type SpaceSemantics,
  type StorageErrorCode,
  type WriteTarget,
} from '@shared/storage';
import type { StorageDirectory } from '../storage/storage-directory';
import type { StorageFile } from '../storage/storage-file';
import { createStorageFileByteSource } from './storage-file-byte-source';
import { preferredChecksum, resolveTransferStrategy } from './transfer-compatibility';
import { TransferExecution } from './transfer-execution';
import { allocateTransferNames, normalizeTargetName } from './transfer-names';
import type {
  CommittedTransferFile,
  SourceDirectoryCleanupEntry,
  TransferMode,
  TransferOperations,
  TransferPlanItem,
  TransferPlanPage,
  TransferSourceSnapshot,
} from './transfer-types';

export interface TransferPlanRoot {
  readonly entry: Entry;
  readonly sourceParent: EntryRef;
  readonly targetName: string;
  readonly existingTarget?: Entry | undefined;
}

interface PlanNode {
  readonly id: number;
  readonly entry: Entry;
  readonly sourceParent: EntryRef;
  readonly targetParent: EntryRef;
  readonly targetName: string;
  readonly relativePath: string;
  readonly depth: number;
  replace: boolean;
  existingTarget?: Entry | undefined;
  code?: StorageErrorCode | undefined;
  cancelled: boolean;
  sourceFile?: StorageFile | undefined;
  sourceDirectory?: StorageDirectory | undefined;
  targetDirectory: StorageDirectory;
  children?: PlanNode[] | undefined;
}

export interface TransferPlanConfig {
  readonly operations: TransferOperations;
  readonly mode: TransferMode;
  readonly targetRoot: EntryRef;
  readonly targetCapabilities: Capabilities;
  readonly targetSemantics?: SpaceSemantics | undefined;
  readonly roots: readonly TransferPlanRoot[];
  readonly confirmed: boolean;
  readonly initialVisitedKeys?: readonly string[] | undefined;
  readonly onDirectoryCreated?: ((parent: EntryRef, entry: Entry) => void) | undefined;
}

async function listTargetChildrenByName(
  directory: StorageDirectory,
  semantics: SpaceSemantics | undefined,
  signal?: AbortSignal,
): Promise<Map<string, Entry>> {
  const result = new Map<string, Entry>();
  if (semantics?.allowsDuplicateNames) return result;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    throwIfAborted(signal);
    const page = await directory.list(cursor ? { cursor } : {}, signal ? { signal } : {});
    throwIfAborted(signal);
    for (const entry of page.entries) {
      result.set(normalizeTargetName(entry.name, semantics), entry);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new StorageError('OutcomeUnknown');
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return result;
}

function buildSourceSnapshot(entry: Entry, parent: EntryRef): TransferSourceSnapshot {
  const checksum = preferredChecksum(entry.checksums);
  return {
    ref: structuredClone(entry.ref),
    parent: structuredClone(parent),
    name: entry.name,
    kind: entry.kind,
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
    ...(checksum ? { checksum } : {}),
  };
}

/** Provider-neutral transfer discovery plan, directory scope owner, and move-cleanup ledger. */
export class TransferPlan {
  private readonly nodes: PlanNode[] = [];
  private readonly operationsMap = new Map<number, AbortController>();
  private readonly discovery = new Map<number, Promise<PlanNode[]>>();
  private readonly visitedDirectories = new Set<string>();
  private readonly committedFiles = new Map<number, CommittedTransferFile>();
  private readonly sourceDirectories: SourceDirectoryCleanupEntry[] = [];
  private scopePromise: Promise<DirectoryScope> | undefined;
  private scope: DirectoryScope | undefined;
  private confirmed: boolean;
  private released = false;
  private finished = false;
  readonly roots: TransferPlanItem[];

  constructor(private readonly config: TransferPlanConfig) {
    this.confirmed = config.confirmed;
    for (const key of config.initialVisitedKeys ?? []) {
      this.visitedDirectories.add(key);
    }
    const targetRootDir = config.operations.directory(config.targetRoot);
    this.roots = config.roots.map((root) =>
      this.snapshot(
        this.addNode({
          entry: root.entry,
          sourceParent: root.sourceParent,
          targetParent: config.targetRoot,
          targetName: root.targetName,
          relativePath: root.targetName,
          depth: 0,
          replace: root.existingTarget !== undefined,
          existingTarget: root.existingTarget,
          targetDirectory: targetRootDir,
          sourceFile:
            root.entry.kind === 'file' ? config.operations.file(root.entry.ref) : undefined,
          sourceDirectory:
            root.entry.kind === 'directory'
              ? config.operations.directory(root.entry.ref)
              : undefined,
        }),
      ),
    );
  }

  confirm(): void {
    this.assertUsable();
    this.confirmed = true;
  }

  async directoryPage(itemId: number, offset: number): Promise<TransferPlanPage> {
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

  async prepareFile(itemId: number): Promise<{
    execution: TransferExecution;
    targetParent: EntryRef;
    sourceSnapshot: TransferSourceSnapshot;
  }> {
    const node = this.node(itemId);
    this.assertConfirmed();
    if (node.code) throw new StorageError(node.code);
    const sourceFile = node.sourceFile;
    if (
      !sourceFile ||
      node.entry.kind !== 'file' ||
      node.entry.capabilities.read?.support === 'unsupported'
    ) {
      throw new StorageError('Unsupported');
    }
    const controller = this.begin(node);
    try {
      const scope = await this.ensureScope(controller.signal);
      // Verify target parent directory identity BEFORE touching or reading the source.
      await scope.assertValid(node.targetParent, { signal: controller.signal });
      const current = await sourceFile.stat({ signal: controller.signal });
      throwIfAborted(controller.signal);
      this.node(itemId);
      if (current.kind === 'file' && current.capabilities.read?.support === 'unsupported') {
        throw new StorageError('Unsupported');
      }
      if (
        current.kind !== 'file' ||
        current.name !== node.entry.name ||
        (node.entry.size !== undefined && current.size !== node.entry.size) ||
        (node.entry.revision !== undefined && current.revision !== node.entry.revision)
      ) {
        throw new StorageError('SourceChanged');
      }

      const writeTarget = this.resolveWriteTarget(node);
      const isReplace = writeTarget.kind === 'replace';
      const compatibility = resolveTransferStrategy(
        current,
        this.config.targetCapabilities,
        isReplace,
      );
      if (!compatibility.supported) {
        throw new StorageError(compatibility.code);
      }

      const { source, checksum } = createStorageFileByteSource(sourceFile, current);
      const sourceSnapshot = buildSourceSnapshot(current, node.sourceParent);
      const execution = new TransferExecution({
        targetDirectory: node.targetDirectory,
        writeTarget,
        directoryScope: scope,
        source,
        sourceSnapshot,
        strategy: compatibility.strategy,
        pausable: compatibility.pausable,
        checksum,
      });
      return {
        execution,
        targetParent: node.targetParent,
        sourceSnapshot,
      };
    } finally {
      this.operationsMap.delete(itemId);
    }
  }

  recordCommittedFile(
    itemId: number,
    targetEntry: Entry,
    sourceSnapshot: TransferSourceSnapshot,
  ): CommittedTransferFile {
    const node = this.nodes[itemId];
    const record: CommittedTransferFile = {
      itemId,
      targetEntry: structuredClone(targetEntry),
      targetParent: structuredClone(node?.targetParent ?? this.config.targetRoot),
      sourceSnapshot: structuredClone(sourceSnapshot),
      sourceDeleted: false,
    };
    this.committedFiles.set(itemId, record);
    return record;
  }

  getCommittedFile(itemId: number): CommittedTransferFile | undefined {
    return this.committedFiles.get(itemId);
  }

  markSourceDeleted(itemId: number): void {
    const record = this.committedFiles.get(itemId);
    if (record) record.sourceDeleted = true;
  }

  getRemainingSourceDirectories(): SourceDirectoryCleanupEntry[] {
    return this.sourceDirectories
      .filter((entry) => !entry.removed)
      .sort((a, b) => b.depth - a.depth);
  }

  markSourceDirectoryDeleted(ref: EntryRef): void {
    const key = entryKey(ref);
    const match = this.sourceDirectories.find((entry) => entryKey(entry.ref) === key);
    if (match) match.removed = true;
  }

  cancelItem(itemId: number): void {
    const node = this.nodes[itemId];
    if (!node) throw new StorageError('InvalidArgument');
    node.cancelled = true;
    this.operationsMap.get(itemId)?.abort();
  }

  finish(): void {
    if (this.operationsMap.size > 0) throw new StorageError('PreconditionFailed');
    this.finished = true;
  }

  reopen(): void {
    this.assertUsable();
    this.finished = false;
  }

  async release(): Promise<void> {
    this.released = true;
    for (const operation of this.operationsMap.values()) operation.abort();
    await Promise.allSettled(this.discovery.values());
    if (!this.finished && this.scope) {
      await this.scope.cleanupCreated();
    }
  }

  private resolveWriteTarget(node: PlanNode): WriteTarget {
    if (node.replace && node.existingTarget) {
      if (node.existingTarget.kind !== 'file') {
        throw new StorageError('InvalidArgument');
      }
      return {
        kind: 'replace',
        ref: node.existingTarget.ref,
        policy: 'replace-unconditionally',
      };
    }
    return {
      kind: 'create',
      parent: node.targetParent,
      name: node.targetName,
      policy: 'create-only',
    };
  }

  private async ensureScope(signal?: AbortSignal): Promise<DirectoryScope> {
    this.scopePromise ??= this.config.operations
      .openDirectoryScope(this.config.targetRoot, signal ? { signal } : {})
      .then((scope) => {
        this.scope = scope;
        return scope;
      })
      .catch((error: unknown) => {
        this.scopePromise = undefined;
        throw error;
      });
    const scope = await this.scopePromise;
    this.assertUsable();
    return scope;
  }

  private async canonicalKey(ref: EntryRef): Promise<string> {
    return (await this.config.operations.canonicalEntryKey?.(ref)) ?? entryKey(ref);
  }

  private async discoverDirectory(node: PlanNode): Promise<PlanNode[]> {
    if (node.children) return node.children;
    const sourceDirectory = node.sourceDirectory;
    if (!sourceDirectory || node.entry.capabilities.list?.support === 'unsupported') {
      throw new StorageError('Unsupported');
    }

    const sourceCanonicalKey = await this.canonicalKey(node.entry.ref);
    if (this.visitedDirectories.has(sourceCanonicalKey)) {
      throw new StorageError('OutcomeUnknown');
    }
    this.visitedDirectories.add(sourceCanonicalKey);

    const controller = this.begin(node);
    try {
      const scope = await this.ensureScope(controller.signal);
      const ensured = await scope.ensureDirectory(
        node.targetParent,
        node.targetName,
        { replace: node.replace },
        { signal: controller.signal },
      );
      throwIfAborted(controller.signal);

      // Shield newly created target directory from being traversed if source & target share a tree.
      const createdCanonicalKey = await this.canonicalKey(ensured.entry.ref);
      this.visitedDirectories.add(createdCanonicalKey);

      if (ensured.created) {
        this.config.onDirectoryCreated?.(node.targetParent, ensured.entry);
      }

      if (this.config.mode === 'move') {
        this.sourceDirectories.push({
          ref: structuredClone(node.entry.ref),
          parent: structuredClone(node.sourceParent),
          depth: node.depth,
          ...(node.entry.revision !== undefined ? { revision: node.entry.revision } : {}),
          removed: false,
        });
      }

      const targetChildDir = node.targetDirectory.child(ensured.entry.ref);
      const existingChildren = ensured.created
        ? new Map<string, Entry>()
        : await listTargetChildrenByName(
            targetChildDir,
            this.config.targetSemantics,
            controller.signal,
          );

      const children = await this.listAllSourceChildren(
        sourceDirectory,
        node.entry.ref,
        controller.signal,
      );
      this.node(node.id);

      const allocatedNames = allocateTransferNames(children, this.config.targetSemantics);
      const childNodes: PlanNode[] = [];
      for (const [index, child] of children.entries()) {
        const allocatedName = allocatedNames[index]!;
        const validName =
          (await this.config.operations.validateEntryName?.(
            this.config.targetRoot.connectionId,
            allocatedName,
          )) ?? true;
        const normalized = normalizeTargetName(allocatedName, this.config.targetSemantics);
        const existingTarget = existingChildren.get(normalized);
        let childCode: StorageErrorCode | undefined;
        if (!validName) {
          childCode = 'InvalidArgument';
        } else if (child.kind !== 'file' && child.kind !== 'directory') {
          childCode = 'Unsupported';
        }
        childNodes.push(
          this.addNode({
            entry: child,
            sourceParent: node.entry.ref,
            targetParent: ensured.entry.ref,
            targetName: allocatedName,
            relativePath: `${node.relativePath}/${allocatedName}`,
            depth: node.depth + 1,
            replace: node.replace,
            existingTarget,
            code: childCode,
            targetDirectory: targetChildDir,
            sourceFile: child.kind === 'file' ? sourceDirectory.file(child.ref) : undefined,
            sourceDirectory:
              child.kind === 'directory' ? sourceDirectory.child(child.ref) : undefined,
          }),
        );
      }
      node.children = childNodes;
      return childNodes;
    } finally {
      this.operationsMap.delete(node.id);
    }
  }

  private async listAllSourceChildren(
    sourceDirectory: StorageDirectory,
    parentRef: EntryRef,
    signal: AbortSignal,
  ): Promise<Entry[]> {
    const entries = new Map<string, Entry>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      throwIfAborted(signal);
      const page = await sourceDirectory.list(cursor ? { cursor } : {}, { signal });
      throwIfAborted(signal);
      for (const child of page.entries) {
        if (
          child.ref.connectionId !== parentRef.connectionId ||
          child.ref.spaceId !== parentRef.spaceId
        ) {
          throw new StorageError('OutcomeUnknown');
        }
        entries.set(entryKey(child.ref), child);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new StorageError('OutcomeUnknown');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return [...entries.values()];
  }

  private addNode(options: {
    entry: Entry;
    sourceParent: EntryRef;
    targetParent: EntryRef;
    targetName: string;
    relativePath: string;
    depth: number;
    replace: boolean;
    existingTarget?: Entry | undefined;
    code?: StorageErrorCode | undefined;
    targetDirectory: StorageDirectory;
    sourceFile?: StorageFile | undefined;
    sourceDirectory?: StorageDirectory | undefined;
  }): PlanNode {
    const node: PlanNode = {
      id: this.nodes.length,
      entry: structuredClone(options.entry),
      sourceParent: structuredClone(options.sourceParent),
      targetParent: structuredClone(options.targetParent),
      targetName: options.targetName,
      relativePath: options.relativePath,
      depth: options.depth,
      replace: options.replace,
      existingTarget: options.existingTarget ? structuredClone(options.existingTarget) : undefined,
      code: options.code,
      cancelled: false,
      targetDirectory: options.targetDirectory,
      sourceFile: options.sourceFile,
      sourceDirectory: options.sourceDirectory,
    };
    this.nodes.push(node);
    return node;
  }

  private snapshot(node: PlanNode): TransferPlanItem {
    return {
      id: node.id,
      entry: structuredClone(node.entry),
      sourceParent: structuredClone(node.sourceParent),
      targetParent: structuredClone(node.targetParent),
      targetName: node.targetName,
      relativePath: node.relativePath,
      replace: node.replace,
      ...(node.existingTarget ? { existingTarget: structuredClone(node.existingTarget) } : {}),
      ...(node.code ? { code: node.code } : {}),
    };
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
    return node;
  }

  private begin(node: PlanNode): AbortController {
    if (this.operationsMap.has(node.id)) throw new StorageError('PreconditionFailed');
    const controller = new AbortController();
    this.operationsMap.set(node.id, controller);
    return controller;
  }
}
