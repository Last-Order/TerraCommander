import { isAbsolute, relative } from 'node:path';
import { StorageError } from '@main/storage';
import type { TaskGroupPreparationContext } from '@main/tasks/types';
import { entryKey, type Entry, type EntryRef } from '@shared/storage';
import { localConnectionId, type BrowserErrorCode } from '@shared/storage-browser';
import type { CopyTaskRequest, PasteEntriesRequest, StorageDirectoryChange } from '@shared/tasks';
import type { StorageBrowser } from '../storage/storage-browser';
import { toBrowserErrorCode, toTaskFailure } from './task-errors';

export interface CopyDiscoveryItem {
  sourceEntry: Entry;
  sourceParent: EntryRef;
  targetParent: EntryRef;
  targetName: string;
  relativePath: string;
  emitAddedOnCreate: boolean;
}

export type PastePlan =
  | { kind: 'empty' }
  | { kind: 'upload'; paths: string[]; removeSources?: readonly Entry[] | undefined }
  | {
      kind: 'download';
      directory: string;
      entries: Entry[];
      removeSources?: readonly Entry[] | undefined;
    }
  | {
      kind: 'copy';
      items: CopyDiscoveryItem[];
      entries: Entry[];
      sameDirectory?: boolean | undefined;
      removeSources?: readonly Entry[] | undefined;
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

export function isSubpath(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function listAllNames(
  browser: StorageBrowser,
  parent: EntryRef,
  caseInsensitive = false,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    if (signal?.aborted) return names;
    const page = await browser.listDirectory(parent, cursor);
    if (signal?.aborted) return names;
    for (const entry of page.entries) {
      names.add(caseInsensitive ? entry.name.toLowerCase() : entry.name);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return names;
}

/** Validates a paste request and resolves it into an upload, download, copy, or move plan. */
export async function planPaste(
  browser: StorageBrowser,
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

  // Cross-source cloud-to-cloud transfer is not supported yet.
  if (
    sourceConnectionId !== localConnectionId &&
    targetConnectionId !== localConnectionId &&
    sourceConnectionId !== targetConnectionId
  ) {
    throw new StorageError('Unsupported');
  }

  // Local -> Cloud: resolve OS paths via local provider integration for upload.
  if (sourceConnectionId === localConnectionId && targetConnectionId !== localConnectionId) {
    const paths: string[] = [];
    for (const entry of uniqueEntries) {
      const resolved = await browser.resolveLocalPath(entry.ref);
      paths.push(resolved.path);
    }
    return mode === 'cut'
      ? { kind: 'upload', paths, removeSources: uniqueEntries }
      : { kind: 'upload', paths };
  }

  // Cloud -> Local: resolve target local directory via local provider integration for download.
  if (sourceConnectionId !== localConnectionId && targetConnectionId === localConnectionId) {
    const target = await browser.resolveLocalPath(request.targetParent);
    if (target.kind !== 'directory') throw new StorageError('InvalidArgument');
    return mode === 'cut'
      ? {
          kind: 'download',
          directory: target.path,
          entries: uniqueEntries,
          removeSources: uniqueEntries,
        }
      : { kind: 'download', directory: target.path, entries: uniqueEntries };
  }

  // Same-connection copy or move (Local -> Local or same-account Cloud -> Cloud).
  let crossDevice = false;
  if (sourceConnectionId === localConnectionId) {
    const target = await browser.resolveLocalPath(request.targetParent);
    if (target.kind !== 'directory') throw new StorageError('InvalidArgument');
    for (const entry of uniqueEntries) {
      if (mode === 'copy' && entry.kind !== 'directory') continue;
      const source = await browser.resolveLocalPath(entry.ref);
      if (
        entry.kind === 'directory' &&
        (target.path === source.path || isSubpath(source.path, target.path))
      ) {
        throw new StorageError('InvalidArgument');
      }
      if (
        mode === 'cut' &&
        target.dev !== undefined &&
        source.dev !== undefined &&
        target.dev !== source.dev
      ) {
        crossDevice = true;
      }
    }
  } else {
    if (mode === 'cut' && request.sourceParent.spaceId !== request.targetParent.spaceId) {
      throw new StorageError('Unsupported');
    }
    for (const entry of uniqueEntries) {
      if (
        entry.kind === 'directory' &&
        entry.ref.locator === request.targetParent.locator &&
        entry.ref.spaceId === request.targetParent.spaceId
      ) {
        throw new StorageError('InvalidArgument');
      }
    }
  }

  if (mode === 'cut') {
    const items: CopyDiscoveryItem[] = uniqueEntries.map((entry) => ({
      sourceEntry: entry,
      sourceParent: request.sourceParent,
      targetParent: request.targetParent,
      targetName: entry.name,
      relativePath: entry.name,
      emitAddedOnCreate: true,
    }));
    if (crossDevice) {
      return { kind: 'copy', items, entries: uniqueEntries, removeSources: uniqueEntries };
    }
    return { kind: 'move', items, entries: uniqueEntries };
  }

  const items: CopyDiscoveryItem[] = uniqueEntries.map((entry) => ({
    sourceEntry: entry,
    sourceParent: request.sourceParent,
    targetParent: request.targetParent,
    targetName: entry.name,
    relativePath: entry.name,
    emitAddedOnCreate: true,
  }));

  return { kind: 'copy', items, entries: uniqueEntries, sameDirectory };
}

/** Deletes source entries after a cross-device or cross-connection move completes cleanly. */
export async function removeMovedSources(
  browser: StorageBrowser,
  sourceParent: EntryRef,
  entries: readonly Entry[],
  emitDirectoryChanged: (change: StorageDirectoryChange) => void,
): Promise<void> {
  for (const entry of entries) {
    try {
      await browser.deleteEntry(entry.ref);
      emitDirectoryChanged({ kind: 'removed', parent: sourceParent, ref: entry.ref });
    } catch {
      console.error('Failed to remove source entry after move.', {
        connectionId: entry.ref.connectionId,
      });
    }
  }
}

export function slotConflictKey(parent: EntryRef, name: string, caseInsensitive = false): string {
  const normalized = caseInsensitive ? name.toLowerCase() : name;
  return `slot:${entryKey(parent)}/${normalized}`;
}

export interface PrepareCopyGroupOptions {
  allowsDuplicateNames?: boolean | undefined;
  caseInsensitive?: boolean | undefined;
  sameDirectory?: boolean | undefined;
  getReservedNames?: (() => ReadonlySet<string> | undefined) | undefined;
  onReserveName?: ((normalizedName: string) => void) | undefined;
}

type CopyGroupPreparationContext = Pick<
  TaskGroupPreparationContext<{ copy: { input: CopyTaskRequest; result: Entry } }>,
  'signal' | 'enqueue' | 'reportIssue'
>;

export async function prepareCopyGroup(
  browser: StorageBrowser,
  request: PasteEntriesRequest,
  initialItems: readonly CopyDiscoveryItem[],
  emitDirectoryChanged: (change: StorageDirectoryChange) => void,
  context: CopyGroupPreparationContext,
  options?: PrepareCopyGroupOptions,
): Promise<void> {
  const pending: CopyDiscoveryItem[] = initialItems.map((item) => ({ ...item }));
  const visitedDirectories = new Set<string>([entryKey(request.targetParent)]);
  const caseInsensitive = options?.caseInsensitive === true;

  if (options?.sameDirectory) {
    const usedNames = await listAllNames(
      browser,
      request.targetParent,
      caseInsensitive,
      context.signal,
    );
    if (context.signal.aborted) return;
    const reservedNames = options.getReservedNames?.();
    if (reservedNames) {
      for (const name of reservedNames) {
        usedNames.add(name);
      }
    }
    for (const item of pending) {
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
    const item = pending.shift()!;

    if (item.sourceEntry.kind !== 'directory') {
      if (item.sourceEntry.kind !== 'file') {
        context.reportIssue({
          label: item.relativePath,
          failure: toTaskFailure(new StorageError('Unsupported')),
        });
        continue;
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
          },
          resources: options?.allowsDuplicateNames
            ? []
            : [slotConflictKey(item.targetParent, item.targetName, caseInsensitive)],
        },
        `${entryKey(item.sourceEntry.ref)}->${entryKey(item.targetParent)}/${item.targetName}`,
      );
      continue;
    }

    const dirKey = entryKey(item.sourceEntry.ref);
    if (visitedDirectories.has(dirKey)) {
      continue;
    }
    visitedDirectories.add(dirKey);

    try {
      const createdDir = await browser.createDirectory({
        parent: item.targetParent,
        name: item.targetName,
      });
      if (context.signal.aborted) return;
      if (item.emitAddedOnCreate) {
        emitDirectoryChanged({ kind: 'added', parent: item.targetParent, entry: createdDir });
      }

      let cursor: string | undefined;
      do {
        if (context.signal.aborted) return;
        const page = await browser.listDirectory(item.sourceEntry.ref, cursor);
        for (const child of page.entries) {
          pending.push({
            sourceEntry: child,
            sourceParent: item.sourceEntry.ref,
            targetParent: createdDir.ref,
            targetName: child.name,
            relativePath: `${item.relativePath}/${child.name}`,
            emitAddedOnCreate: false,
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
