import { StorageError } from '@main/storage';
import type { TaskGroupPreparationContext } from '@main/tasks/types';
import { entryKey, type Entry, type EntryRef } from '@shared/storage';
import type { BrowserErrorCode } from '@shared/storage-browser';
import type {
  CopyTaskRequest,
  PasteEntriesRequest,
  PasteRejectionReason,
  StorageDirectoryChange,
} from '@shared/tasks';
import type { StorageDirectory } from '../storage/storage-directory';
import type { StorageEntryOperations } from '../storage/storage-entry-operations';
import { resolveTransferStrategy } from '../transfers/transfer-compatibility';
import type { SourceDirectoryCleanupEntry } from '../transfers/transfer-types';
import { toBrowserErrorCode, toTaskFailure } from './task-errors';

export type CopyPasteOperations = Pick<
  StorageEntryOperations,
  | 'directory'
  | 'inspectTransfer'
  | 'inspectCrossConnectionTransfer'
  | 'spaceCapabilities'
  | 'canonicalEntryKey'
>;

export interface CopyDiscoveryItem {
  sourceEntry: Entry;
  sourceParent: EntryRef;
  targetParent: EntryRef;
  targetName: string;
  relativePath: string;
  emitAddedOnCreate: boolean;
  depth: number;
}

export type PastePlan =
  | { kind: 'empty' }
  | { kind: 'rejected'; reason: PasteRejectionReason }
  | { kind: 'transfer'; mode: 'copy' | 'move'; entries: Entry[] }
  | {
      kind: 'copy';
      items: CopyDiscoveryItem[];
      entries: Entry[];
      sameDirectory?: boolean | undefined;
      moveAfterCopy?: boolean | undefined;
    }
  | { kind: 'move'; items: CopyDiscoveryItem[]; entries: Entry[] };

const fatalCopyErrorCodes: ReadonlySet<BrowserErrorCode> = new Set<BrowserErrorCode>([
  'AuthRequired',
  'PermissionDenied',
  'InsufficientSpace',
]);

/** Generates a non-conflicting copy name (e.g. `report - Copy.pdf`, `report - Copy (2).pdf`). */
export function allocateCopyName(
  name: string,
  kind: Entry['kind'],
  usedNames: Set<string>,
  caseInsensitive = false,
): string {
  const dotIndex = kind === 'directory' ? -1 : name.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? name.slice(0, dotIndex) : name;
  const extension = hasExtension ? name.slice(dotIndex) : '';
  const normalize = (value: string) => (caseInsensitive ? value.toLowerCase() : value);

  const firstCandidate = `${stem} - Copy${extension}`;
  const firstKey = normalize(firstCandidate);
  if (!usedNames.has(firstKey)) {
    usedNames.add(firstKey);
    return firstCandidate;
  }
  let index = 2;
  while (true) {
    const candidate = `${stem} - Copy (${index})${extension}`;
    const key = normalize(candidate);
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
    index += 1;
  }
}

async function listAllNames(
  directory: Pick<StorageDirectory, 'list'>,
  caseInsensitive = false,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    if (signal?.aborted) return names;
    const page = await directory.list(cursor);
    if (signal?.aborted) return names;
    for (const entry of page.entries) {
      names.add(caseInsensitive ? entry.name.toLowerCase() : entry.name);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return names;
}

/** Provider-neutral unified planner for paste, OS drops, file dialogs, and save-to-local transfers. */
export async function planPaste(
  operations: CopyPasteOperations,
  request: PasteEntriesRequest,
): Promise<PastePlan> {
  const mode = request.mode ?? 'copy';
  const sourceConnectionId = request.sourceParent.connectionId;
  const targetConnectionId = request.targetParent.connectionId;
  const uniqueEntries: Entry[] = [];
  const seen = new Set<string>();
  for (const entry of request.entries) {
    if (
      entry.ref.connectionId !== sourceConnectionId ||
      entry.ref.spaceId !== request.sourceParent.spaceId
    ) {
      throw new StorageError('InvalidArgument');
    }
    const key = entryKey(entry.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueEntries.push(entry);
  }
  if (uniqueEntries.length === 0) return { kind: 'empty' };

  const sameDirectory = entryKey(request.sourceParent) === entryKey(request.targetParent);
  if (mode === 'cut' && sameDirectory) {
    return { kind: 'empty' };
  }

  const hasDirectory = uniqueEntries.some((entry) => entry.kind === 'directory');
  if (
    hasDirectory &&
    request.targetAncestors &&
    uniqueEntries.some(
      (entry) =>
        entry.kind === 'directory' &&
        request.targetAncestors!.some((ancestor) => entryKey(ancestor) === entryKey(entry.ref)),
    )
  ) {
    return { kind: 'rejected', reason: 'self-containment' };
  }

  const targetDirectory = operations.directory(request.targetParent);

  // Any cross-connection pair (Local <-> Cloud, Cloud A <-> Cloud B, etc.) uses unified transfer.
  if (sourceConnectionId !== targetConnectionId) {
    const crossInspection = await operations.inspectCrossConnectionTransfer(
      request.targetParent,
      request.targetAncestors,
      uniqueEntries.map((entry) => ({ ref: entry.ref, kind: entry.kind })),
    );
    if (crossInspection.selfContained) {
      return { kind: 'rejected', reason: 'self-containment' };
    }

    const [spaceCaps, targetEntry] = await Promise.all([
      operations.spaceCapabilities(request.targetParent),
      targetDirectory.stat(),
    ]);
    if (targetEntry.kind !== 'directory') throw new StorageError('InvalidArgument');
    const targetCaps = { ...spaceCaps, ...targetEntry.capabilities };
    if (targetCaps.write?.support === 'unsupported') {
      return { kind: 'rejected', reason: 'permission-denied' };
    }
    if (hasDirectory && targetCaps.createDirectory?.support === 'unsupported') {
      return { kind: 'rejected', reason: 'unsupported' };
    }
    if (
      mode === 'cut' &&
      uniqueEntries.some((entry) => entry.capabilities.remove?.support === 'unsupported')
    ) {
      return { kind: 'rejected', reason: 'unsupported' };
    }
    for (const entry of uniqueEntries) {
      if (entry.kind === 'directory') {
        if (entry.capabilities.list?.support === 'unsupported') {
          return { kind: 'rejected', reason: 'unsupported' };
        }
        continue;
      }
      const compat = resolveTransferStrategy(entry, targetCaps, false);
      if (!compat.supported) {
        return {
          kind: 'rejected',
          reason: compat.code === 'PermissionDenied' ? 'permission-denied' : 'unsupported',
        };
      }
    }
    return {
      kind: 'transfer',
      mode: mode === 'cut' ? 'move' : 'copy',
      entries: uniqueEntries,
    };
  }

  // Same-connection copy or move (native fast path for every provider).
  const inspection = await operations.inspectTransfer(
    request.targetParent,
    uniqueEntries.map((entry) => ({ ref: entry.ref, kind: entry.kind })),
    mode === 'cut' ? 'move' : 'copy',
  );
  if (inspection.selfContained) {
    return { kind: 'rejected', reason: 'self-containment' };
  }
  if (mode === 'cut' && inspection.moveStrategy === 'unsupported') {
    return { kind: 'rejected', reason: 'unsupported' };
  }

  if (mode === 'cut' && inspection.moveStrategy === 'native') {
    if (uniqueEntries.some((entry) => entry.capabilities.moveWithin?.support === 'unsupported')) {
      return { kind: 'rejected', reason: 'unsupported' };
    }
    const items: CopyDiscoveryItem[] = uniqueEntries.map((entry) => ({
      sourceEntry: entry,
      sourceParent: request.sourceParent,
      targetParent: request.targetParent,
      targetName: entry.name,
      relativePath: entry.name,
      emitAddedOnCreate: true,
      depth: 0,
    }));
    return { kind: 'move', items, entries: uniqueEntries };
  }

  if (hasDirectory) {
    const targetCapabilities = await targetDirectory.capabilities();
    if (targetCapabilities.createDirectory?.support === 'unsupported') {
      return { kind: 'rejected', reason: 'unsupported' };
    }
  }
  if (
    uniqueEntries.some(
      (entry) => entry.kind === 'file' && entry.capabilities.copyWithin?.support === 'unsupported',
    )
  ) {
    return { kind: 'rejected', reason: 'unsupported' };
  }
  if (
    mode === 'cut' &&
    uniqueEntries.some((entry) => entry.capabilities.remove?.support === 'unsupported')
  ) {
    return { kind: 'rejected', reason: 'unsupported' };
  }

  const items: CopyDiscoveryItem[] = uniqueEntries.map((entry) => ({
    sourceEntry: entry,
    sourceParent: request.sourceParent,
    targetParent: request.targetParent,
    targetName: entry.name,
    relativePath: entry.name,
    emitAddedOnCreate: true,
    depth: 0,
  }));

  if (mode === 'cut') {
    return { kind: 'copy', items, entries: uniqueEntries, moveAfterCopy: true };
  }

  return { kind: 'copy', items, entries: uniqueEntries, sameDirectory };
}

export function slotConflictKey(parent: EntryRef, name: string, caseInsensitive = false): string {
  const normalized = caseInsensitive ? name.toLowerCase() : name;
  return `slot:${entryKey(parent)}/${normalized}`;
}

export interface PrepareCopyGroupOptions {
  allowsDuplicateNames?: boolean | undefined;
  caseInsensitive?: boolean | undefined;
  sameDirectory?: boolean | undefined;
  moveAfterCopy?: boolean | undefined;
  canonicalKey?: ((ref: EntryRef) => Promise<string | undefined>) | undefined;
  onSourceDirectoryDiscovered?: ((entry: SourceDirectoryCleanupEntry) => void) | undefined;
  getReservedNames?: (() => ReadonlySet<string> | undefined) | undefined;
  onReserveName?: ((normalizedName: string) => void) | undefined;
}

type CopyGroupPreparationContext = Pick<
  TaskGroupPreparationContext<{ copy: { input: CopyTaskRequest; result: Entry } }>,
  'signal' | 'enqueue' | 'reportIssue'
>;

interface PendingCopyItem {
  item: CopyDiscoveryItem;
  targetDirectory: StorageDirectory;
  sourceDirectory?: StorageDirectory | undefined;
}

export interface CopyGroupDirectories {
  readonly sourceDirectory: StorageDirectory;
  readonly targetDirectory: StorageDirectory;
}

export async function prepareCopyGroup(
  { sourceDirectory, targetDirectory }: CopyGroupDirectories,
  request: PasteEntriesRequest,
  initialItems: readonly CopyDiscoveryItem[],
  emitDirectoryChanged: (change: StorageDirectoryChange) => void,
  context: CopyGroupPreparationContext,
  options?: PrepareCopyGroupOptions,
): Promise<void> {
  const resolveCanonicalKey = async (ref: EntryRef) =>
    (await options?.canonicalKey?.(ref)) ?? entryKey(ref);

  const targetKey = entryKey(targetDirectory.ref);
  const pending: PendingCopyItem[] = initialItems.map((item) => ({
    item: { ...item },
    targetDirectory:
      entryKey(item.targetParent) === targetKey
        ? targetDirectory
        : targetDirectory.child(item.targetParent),
    sourceDirectory:
      item.sourceEntry.kind === 'directory'
        ? sourceDirectory.child(item.sourceEntry.ref)
        : undefined,
  }));
  const visitedDirectories = new Set<string>([await resolveCanonicalKey(targetDirectory.ref)]);
  const caseInsensitive = options?.caseInsensitive === true;

  if (options?.sameDirectory) {
    const usedNames = await listAllNames(targetDirectory, caseInsensitive, context.signal);
    if (context.signal.aborted) return;
    const reservedNames = options.getReservedNames?.();
    if (reservedNames) {
      for (const name of reservedNames) {
        usedNames.add(name);
      }
    }
    for (const entry of pending) {
      const { item } = entry;
      const targetName = allocateCopyName(
        item.sourceEntry.name,
        item.sourceEntry.kind,
        usedNames,
        caseInsensitive,
      );
      const normalized = caseInsensitive ? targetName.toLowerCase() : targetName;
      options.onReserveName?.(normalized);
      item.targetName = targetName;
      item.relativePath = targetName;
    }
  }

  while (pending.length > 0) {
    if (context.signal.aborted) return;
    const pendingItem = pending.shift()!;
    const { item } = pendingItem;

    if (item.sourceEntry.kind !== 'directory') {
      if (item.sourceEntry.kind !== 'file') {
        context.reportIssue({
          label: item.relativePath,
          failure: toTaskFailure(new StorageError('Unsupported')),
        });
        continue;
      }
      const resources = options?.allowsDuplicateNames
        ? []
        : [slotConflictKey(item.targetParent, item.targetName, caseInsensitive)];
      if (options?.moveAfterCopy) {
        resources.push(entryKey(item.sourceEntry.ref));
      }
      await context.enqueue(
        {
          type: 'copy',
          input: {
            sourceParent: item.sourceParent,
            entry: item.sourceEntry,
            targetParent: item.targetParent,
            targetName: item.targetName,
            sourceDirectoryPath: request.sourceDirectoryPath,
            targetDirectoryPath: request.targetDirectoryPath,
            displayName: item.relativePath,
            ...(options?.moveAfterCopy ? { removeSourceAfterCopy: true } : {}),
          },
          resources,
        },
        `${entryKey(item.sourceEntry.ref)}->${entryKey(item.targetParent)}/${item.targetName}`,
      );
      continue;
    }

    const dirKey = await resolveCanonicalKey(item.sourceEntry.ref);
    if (visitedDirectories.has(dirKey)) {
      continue;
    }
    visitedDirectories.add(dirKey);

    try {
      const { entry: createdDir, directory: createdDirectory } =
        await pendingItem.targetDirectory.createDirectory(item.targetName);
      if (context.signal.aborted) return;
      visitedDirectories.add(await resolveCanonicalKey(createdDir.ref));
      if (item.emitAddedOnCreate) {
        emitDirectoryChanged({ kind: 'added', parent: item.targetParent, entry: createdDir });
      }
      if (options?.moveAfterCopy) {
        options.onSourceDirectoryDiscovered?.({
          ref: structuredClone(item.sourceEntry.ref),
          parent: structuredClone(item.sourceParent),
          depth: item.depth,
          ...(item.sourceEntry.revision !== undefined
            ? { revision: item.sourceEntry.revision }
            : {}),
          removed: false,
        });
      }

      const currentSourceDirectory =
        pendingItem.sourceDirectory ?? sourceDirectory.child(item.sourceEntry.ref);
      let cursor: string | undefined;
      do {
        if (context.signal.aborted) return;
        const page = await currentSourceDirectory.list(cursor);
        for (const child of page.entries) {
          pending.push({
            item: {
              sourceEntry: child,
              sourceParent: item.sourceEntry.ref,
              targetParent: createdDir.ref,
              targetName: child.name,
              relativePath: `${item.relativePath}/${child.name}`,
              emitAddedOnCreate: false,
              depth: item.depth + 1,
            },
            targetDirectory: createdDirectory,
            sourceDirectory:
              child.kind === 'directory' ? currentSourceDirectory.child(child.ref) : undefined,
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    } catch (error) {
      if (context.signal.aborted) return;
      const code = toBrowserErrorCode(error);
      if (code && fatalCopyErrorCodes.has(code)) {
        throw error;
      }
      context.reportIssue({
        label: item.relativePath,
        failure: toTaskFailure(error),
      });
    }
  }
}
