import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, posix, relative, resolve, sep } from 'node:path';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import { localSpace } from '@main/storage/providers/local/local-adapter';
import {
  defaultLocalPlatform,
  type LocalPlatform,
} from '@main/storage/providers/local/local-platform';
import { listLocalVolumes } from '@main/storage/providers/local/local-volumes';
import { entryKey, type Entry, type EntryRef } from '@shared/storage';
import { internalLocalConnectionId } from './providers/local-storage-provider';
import type { StorageEntryOperations } from './storage-entry-operations';
import type { StorageSpaceCatalog } from './storage-spaces';

export interface ResolvedLocalDirectory {
  readonly ref: EntryRef;
  readonly entry: Entry;
  readonly canonicalPath: string;
}

export interface ResolvedLocalPathGroup {
  readonly parent: EntryRef;
  readonly parentDisplayPath: string;
  readonly entries: Entry[];
}

export interface LocalPathBridgeOptions {
  readonly spaces: Pick<StorageSpaceCatalog, 'ensureDiscovered'>;
  readonly operations: Pick<StorageEntryOperations, 'statEntry'>;
  readonly listVolumes?: typeof listLocalVolumes | undefined;
  readonly platform?: LocalPlatform | undefined;
  readonly connectionId?: string | undefined;
}

function mapPathError(error: unknown): never {
  if (error instanceof StorageError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    throw new StorageError('NotFound', { cause: error });
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    throw new StorageError('PermissionDenied', { cause: error });
  }
  if (code === 'EINVAL' || code === 'ENAMETOOLONG') {
    throw new StorageError('InvalidArgument', { cause: error });
  }
  throw new StorageError('OutcomeUnknown', { cause: error });
}

function toLocator(volumePath: string, fullPath: string): string {
  const rel = relative(volumePath, fullPath);
  if (!rel || rel === '.') return '.';
  const segments = rel.split(sep).filter((segment) => segment.length > 0);
  return segments.length > 0 ? posix.join(...segments) : '.';
}

function findMatchingVolume(
  targetPath: string,
  volumes: readonly string[],
  platform: LocalPlatform,
): string | undefined {
  const normalizedTarget = normalize(targetPath);
  let best: string | undefined;
  for (const volume of volumes) {
    const normalizedVolume = normalize(volume);
    if (!platform.isSameOrSubpath(normalizedVolume, normalizedTarget)) continue;
    if (!best || normalizedVolume.length > best.length) {
      best = normalizedVolume;
    }
  }
  return best;
}

/**
 * Desktop OS boundary bridge that maps native OS paths (from dialogs or Explorer/Finder drops)
 * into ordinary local EntryRefs while silently discovering volumes without mutating sidebar selections.
 */
export class LocalPathBridge {
  private readonly connectionId: string;
  private readonly listVolumes: typeof listLocalVolumes;
  private readonly platform: LocalPlatform;

  constructor(private readonly options: LocalPathBridgeOptions) {
    this.connectionId = options.connectionId ?? internalLocalConnectionId;
    this.listVolumes = options.listVolumes ?? listLocalVolumes;
    this.platform = options.platform ?? defaultLocalPlatform;
  }

  async resolveDirectory(inputPath: string, signal?: AbortSignal): Promise<ResolvedLocalDirectory> {
    throwIfAborted(signal);
    if (!inputPath || inputPath.includes('\0') || !isAbsolute(inputPath)) {
      throw new StorageError('InvalidArgument');
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(inputPath);
      const info = await lstat(canonicalPath);
      if (!info.isDirectory()) throw new StorageError('InvalidArgument');
      await access(canonicalPath, constants.W_OK);
    } catch (error) {
      mapPathError(error);
    }
    throwIfAborted(signal);

    const ref = await this.pathToRef(canonicalPath, signal);
    const entry = await this.options.operations.statEntry(ref, signal ? { signal } : {});
    if (entry.kind !== 'directory') throw new StorageError('InvalidArgument');
    return { ref, entry, canonicalPath };
  }

  async resolvePaths(
    rawPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<ResolvedLocalPathGroup[]> {
    throwIfAborted(signal);
    if (rawPaths.length === 0) throw new StorageError('InvalidArgument');

    const groupsByParent = new Map<string, ResolvedLocalPathGroup>();
    const seenEntries = new Set<string>();

    for (const rawPath of rawPaths) {
      throwIfAborted(signal);
      if (!rawPath || rawPath.includes('\0')) throw new StorageError('InvalidArgument');
      const absolutePath = resolve(rawPath);
      // Resolve parent via realpath while keeping leaf un-dereferenced so symlinks are not followed.
      const parentDir = dirname(absolutePath);
      const leafName = basename(absolutePath);
      if (!leafName) throw new StorageError('InvalidArgument');

      let canonicalParent: string;
      let leafPath: string;
      try {
        canonicalParent = await realpath(parentDir);
        leafPath = normalize(`${canonicalParent}${sep}${leafName}`);
        const leafStat = await lstat(leafPath);
        if (!leafStat.isFile() && !leafStat.isDirectory()) {
          throw new StorageError('Unsupported');
        }
      } catch (error) {
        mapPathError(error);
      }

      const parentRef = await this.pathToRef(canonicalParent, signal);
      const entryRef = await this.pathToRef(leafPath, signal);
      const key = entryKey(entryRef);
      if (seenEntries.has(key)) continue;
      seenEntries.add(key);

      const entry = await this.options.operations.statEntry(entryRef, signal ? { signal } : {});
      if (entry.kind !== 'file' && entry.kind !== 'directory') {
        throw new StorageError('Unsupported');
      }

      const parentKey = entryKey(parentRef);
      let group = groupsByParent.get(parentKey);
      if (!group) {
        group = {
          parent: parentRef,
          parentDisplayPath: canonicalParent,
          entries: [],
        };
        groupsByParent.set(parentKey, group);
      }
      group.entries.push(entry);
    }

    return [...groupsByParent.values()];
  }

  private async pathToRef(targetPath: string, signal?: AbortSignal): Promise<EntryRef> {
    await this.options.spaces.ensureDiscovered(this.connectionId);
    let volumes = await this.listVolumes(signal);
    throwIfAborted(signal);
    let matchedVolume = findMatchingVolume(targetPath, volumes, this.platform);
    if (!matchedVolume) {
      // Retry once after refreshing volumes in case a newly mounted drive was selected.
      await this.options.spaces.ensureDiscovered(this.connectionId, true);
      volumes = await this.listVolumes(signal);
      throwIfAborted(signal);
      matchedVolume = findMatchingVolume(targetPath, volumes, this.platform);
    }
    if (!matchedVolume) {
      throw new StorageError('NotFound');
    }
    const space = localSpace(this.connectionId, matchedVolume, this.platform);
    return {
      connectionId: this.connectionId,
      spaceId: space.id,
      locator: toLocator(matchedVolume, targetPath),
    };
  }
}
