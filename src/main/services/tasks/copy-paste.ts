import { isAbsolute, relative } from 'node:path';
import type { Entry, EntryRef } from '@shared/storage';
import { localConnectionId, type BrowserErrorCode } from '@shared/storage-browser';
import type { PasteEntriesRequest, StorageDirectoryChange } from '@shared/tasks';
import { StorageError } from '@main/storage';
import type { TaskDefinitions, TaskGroupPreparationContext } from '@main/tasks/types';
import type { StorageBrowser } from '../storage/storage-browser';
import { entryKey, toBrowserErrorCode, toTaskFailure } from './task-errors';

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
  | { kind: 'upload'; paths: string[] }
  | { kind: 'download'; directory: string; entries: Entry[] }
  | { kind: 'copy'; items: CopyDiscoveryItem[]; entries: Entry[] };

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

export async function listAllNames(
  browser: StorageBrowser,
  parent: EntryRef,
  caseInsensitive = false,
): Promise<Set<string>> {
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await browser.listDirectory(parent, cursor);
    for (const entry of page.entries) {
      names.add(caseInsensitive ? entry.name.toLowerCase() : entry.name);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return names;
}

/** Validates a paste request and resolves it into an upload, download, or same-connection copy plan. */
export async function planPaste(
  browser: StorageBrowser,
  request: PasteEntriesRequest,
): Promise<PastePlan> {
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
    return { kind: 'upload', paths };
  }

  // Cloud -> Local: resolve target local directory via local provider integration for download.
  if (sourceConnectionId !== localConnectionId && targetConnectionId === localConnectionId) {
    const target = await browser.resolveLocalPath(request.targetParent);
    if (target.kind !== 'directory') throw new StorageError('InvalidArgument');
    return { kind: 'download', directory: target.path, entries: uniqueEntries };
  }

  // Same-connection copy (Local -> Local or same-account Cloud -> Cloud).
  if (sourceConnectionId === localConnectionId) {
    const target = await browser.resolveLocalPath(request.targetParent);
    if (target.kind !== 'directory') throw new StorageError('InvalidArgument');
    for (const entry of uniqueEntries) {
      if (entry.kind !== 'directory') continue;
      const source = await browser.resolveLocalPath(entry.ref);
      if (target.path === source.path || isSubpath(source.path, target.path)) {
        throw new StorageError('InvalidArgument');
      }
    }
  } else {
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

  const sameDirectory = entryKey(request.sourceParent) === entryKey(request.targetParent);
  const caseInsensitive = sourceConnectionId === localConnectionId && process.platform === 'win32';
  const usedNames = sameDirectory
    ? await listAllNames(browser, request.targetParent, caseInsensitive)
    : undefined;

  const items: CopyDiscoveryItem[] = uniqueEntries.map((entry) => {
    const targetName = usedNames
      ? allocateCopyName(entry.name, entry.kind, usedNames, caseInsensitive)
      : entry.name;
    return {
      sourceEntry: entry,
      sourceParent: request.sourceParent,
      targetParent: request.targetParent,
      targetName,
      relativePath: targetName,
      emitAddedOnCreate: true,
    };
  });

  return { kind: 'copy', items, entries: uniqueEntries };
}

export async function prepareCopyGroup<
  TTasks extends TaskDefinitions & {
    copy: {
      input: {
        sourceParent: EntryRef;
        entry: Entry;
        targetParent: EntryRef;
        targetName: string;
        sourceDirectoryPath: string;
        targetDirectoryPath: string;
        displayName?: string | undefined;
      };
      result: Entry;
    };
  },
>(
  browser: StorageBrowser,
  request: PasteEntriesRequest,
  initialItems: readonly CopyDiscoveryItem[],
  emitDirectoryChanged: (change: StorageDirectoryChange) => void,
  context: TaskGroupPreparationContext<TTasks>,
): Promise<void> {
  const pending: CopyDiscoveryItem[] = [...initialItems];
  const visitedDirectories = new Set<string>([entryKey(request.targetParent)]);
  let discoveredFiles = 0;
  let scannedDirectories = 0;

  const updateProgress = () => {
    context.reportProgress({
      kind: 'indeterminate',
      stage: { key: 'storage:copyScanning' },
      summary: {
        key: 'storage:copyPreparationProgress',
        values: { files: discoveredFiles, folders: scannedDirectories },
      },
    });
  };
  updateProgress();

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
      discoveredFiles += 1;
      updateProgress();
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
        } as Parameters<typeof context.enqueue>[0],
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
      scannedDirectories += 1;
      updateProgress();

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
