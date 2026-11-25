import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  access,
  constants,
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, parse, relative } from 'node:path';
import type { OperationContext } from '@main/storage/core/contracts';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import type { AdapterFactory, StorageAdapter } from '@main/storage/ports/adapter';
import type {
  Capabilities,
  Capability,
  CapabilityScope,
  CreateTarget,
  Entry,
  EntryPage,
  EntryRef,
  ListRequest,
  Space,
  SpaceSemantics,
} from '@shared/storage';
import {
  defaultLocalPlatform,
  joinLocalLocator,
  parentLocalLocator,
  splitLocalLocator,
  type LocalPlatform,
} from './local-platform';
import { listLocalVolumes } from './local-volumes';

const supported = { support: 'supported' } as const;
const unsupported = { support: 'unsupported' } as const;
const unknown = { support: 'unknown' } as const;
export function localSpaceSemanticsFor(
  platform: LocalPlatform = defaultLocalPlatform,
): SpaceSemantics {
  return { allowsDuplicateNames: false, caseSensitive: platform.caseSensitive };
}
export const localSpaceSemantics: SpaceSemantics = localSpaceSemanticsFor();
const localBaseCapabilities: Capabilities = {
  list: supported,
  read: unsupported,
  write: unsupported,
  createDirectory: unknown,
  remove: supported,
  copyWithin: unknown,
  moveWithin: unknown,
  rename: supported,
  rangeRead: unsupported,
  conditionalRead: unsupported,
  conditionalWrite: unsupported,
  resumeWrite: unsupported,
};
const metadataBatchSize = 32;

export function localSpace(
  connectionId: string,
  directory: string,
  platform: LocalPlatform = defaultLocalPlatform,
): Space {
  const path = normalize(directory);
  const id = createHash('sha256').update(path).digest('hex');
  return {
    id,
    connectionId,
    name: basename(path) || parse(path).root,
    root: { connectionId, spaceId: id, locator: '.' },
    semantics: localSpaceSemanticsFor(platform),
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function localFailure(error: unknown, signal?: AbortSignal): never {
  throwIfAborted(signal);
  const code = errorCode(error);
  const options = code ? { cause: error, providerCode: code } : { cause: error };
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new StorageError('NotFound', options);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    throw new StorageError('PermissionDenied', options);
  }
  if (code === 'EEXIST' || code === 'ENOTEMPTY') {
    throw new StorageError('AlreadyExists', options);
  }
  if (code === 'EINVAL' || code === 'ENAMETOOLONG' || code === 'EISDIR') {
    throw new StorageError('InvalidArgument', options);
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    throw new StorageError('InsufficientSpace', options);
  }
  if (code === 'EXDEV') {
    throw new StorageError('Unsupported', options);
  }
  throw error;
}

export function localAdapterFactory(
  volumes: typeof listLocalVolumes = listLocalVolumes,
  platform: LocalPlatform = defaultLocalPlatform,
): AdapterFactory {
  return {
    provider: 'local',
    async create(connection) {
      return new LocalAdapter(connection.id, volumes, platform);
    },
  };
}

export async function locateLocalEntry(
  ref: EntryRef,
  volumes: typeof listLocalVolumes = listLocalVolumes,
  cachedVolumes?: Map<string, string>,
  signal?: AbortSignal,
  platform: LocalPlatform = defaultLocalPlatform,
): Promise<{ path: string; info: Stats; kind: Entry['kind'] }> {
  throwIfAborted(signal);
  const names = splitLocalLocator(ref.locator);
  if (names.some((name) => !platform.isValidLocatorSegment(name))) {
    throw new StorageError('InvalidArgument');
  }

  let path = cachedVolumes?.get(ref.spaceId);
  if (!path) {
    const discovered = await volumes(signal);
    throwIfAborted(signal);
    if (cachedVolumes) {
      cachedVolumes.clear();
      for (const volumePath of discovered) {
        cachedVolumes.set(localSpace(ref.connectionId, volumePath).id, volumePath);
      }
      path = cachedVolumes.get(ref.spaceId);
    } else {
      path = discovered.find(
        (volumePath) => localSpace(ref.connectionId, volumePath).id === ref.spaceId,
      );
    }
  }
  if (!path) throw new StorageError('NotFound');

  try {
    let info = await lstat(path);
    for (const name of names) {
      // Directory traversal never follows a symlink or junction.
      if (!info.isDirectory()) throw new StorageError('NotFound');
      throwIfAborted(signal);
      path = join(path, name);
      info = await lstat(path);
    }
    throwIfAborted(signal);
    return { path, info, kind: entryKind(info) };
  } catch (error) {
    localFailure(error, signal);
  }
}

class LocalAdapter implements StorageAdapter {
  private readonly volumePaths = new Map<string, string>();

  constructor(
    readonly connectionId: string,
    private readonly volumes: typeof listLocalVolumes,
    private readonly platform: LocalPlatform,
  ) {}

  async listSpaces({ signal }: OperationContext): Promise<Space[]> {
    const paths = await this.volumes(signal);
    throwIfAborted(signal);
    this.volumePaths.clear();
    const spaces = new Map<string, Space>();
    for (const path of paths) {
      const space = localSpace(this.connectionId, path, this.platform);
      this.volumePaths.set(space.id, path);
      spaces.set(space.id, space);
    }
    return [...spaces.values()];
  }

  async capabilities(scope: CapabilityScope, ctx: OperationContext): Promise<Capabilities> {
    throwIfAborted(ctx.signal);
    if (scope.kind === 'entry') {
      return (await this.stat(scope.ref, ctx)).capabilities;
    }
    return { ...localBaseCapabilities };
  }

  async stat(ref: EntryRef, { signal }: OperationContext): Promise<Entry> {
    const { path, info } = await this.locate(ref, signal);
    return this.toEntry(ref, basename(path) || parse(path).root, path, info, signal);
  }

  async list(
    parent: EntryRef,
    { cursor }: ListRequest,
    { signal }: OperationContext,
  ): Promise<EntryPage> {
    if (cursor !== undefined) throw new StorageError('InvalidArgument');
    const { path, info } = await this.locate(parent, signal);
    if (!info.isDirectory()) throw new StorageError('InvalidArgument');

    try {
      const items = await readdir(path, { withFileTypes: true });
      throwIfAborted(signal);
      items.sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
      const entries: Entry[] = [];
      for (let offset = 0; offset < items.length; offset += metadataBatchSize) {
        const batch = await Promise.all(
          items.slice(offset, offset + metadataBatchSize).map(async (item) => {
            const ref = { ...parent, locator: joinLocalLocator(parent.locator, item.name) };
            const displayPath = join(path, item.name);
            // A listed item can disappear or become inaccessible before metadata is read.
            const info = await lstat(displayPath).catch(() => undefined);
            return this.toEntry(ref, item.name, displayPath, info ?? item);
          }),
        );
        throwIfAborted(signal);
        entries.push(...batch);
      }
      return { entries };
    } catch (error) {
      localFailure(error, signal);
    }
  }

  async rename(ref: EntryRef, name: string, { signal }: OperationContext): Promise<Entry> {
    if (ref.locator === '.' || !this.platform.isValidEntryName(name)) {
      throw new StorageError('InvalidArgument');
    }
    const { path, info } = await this.locate(ref, signal);
    if (basename(path) === name) return this.toEntry(ref, name, path, info, signal);
    return this.performRename({
      sourcePath: path,
      sourceInfo: info,
      parentPath: dirname(path),
      name,
      sameParent: true,
      targetRef: { ...ref, locator: joinLocalLocator(parentLocalLocator(ref.locator), name) },
      signal,
    });
  }

  async createDirectory(
    { parent, name }: CreateTarget,
    { signal }: OperationContext,
  ): Promise<Entry> {
    if (!this.platform.isValidEntryName(name)) throw new StorageError('InvalidArgument');
    const { path: parentPath, info } = await this.locate(parent, signal);
    if (!info.isDirectory()) throw new StorageError('InvalidArgument');
    const targetPath = join(parentPath, name);
    try {
      throwIfAborted(signal);
      await mkdir(targetPath);
      return await this.stat(
        { ...parent, locator: joinLocalLocator(parent.locator, name) },
        signal ? { signal } : {},
      );
    } catch (error) {
      localFailure(error, signal);
    }
  }

  async copyWithin(
    ref: EntryRef,
    { parent, name }: CreateTarget,
    { signal }: OperationContext,
  ): Promise<Entry> {
    if (ref.locator === '.' || !this.platform.isValidEntryName(name)) {
      throw new StorageError('InvalidArgument');
    }
    const { path: sourcePath, info: sourceInfo } = await this.locate(ref, signal);
    if (!sourceInfo.isFile()) throw new StorageError('Unsupported');
    const { path: parentPath, info: parentInfo } = await this.locate(parent, signal);
    if (!parentInfo.isDirectory()) throw new StorageError('InvalidArgument');
    const targetPath = join(parentPath, name);
    try {
      throwIfAborted(signal);
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
      return await this.stat(
        { ...parent, locator: joinLocalLocator(parent.locator, name) },
        signal ? { signal } : {},
      );
    } catch (error) {
      localFailure(error, signal);
    }
  }

  async moveWithin(
    ref: EntryRef,
    { parent, name }: CreateTarget,
    { signal }: OperationContext,
  ): Promise<Entry> {
    if (ref.locator === '.' || !this.platform.isValidEntryName(name)) {
      throw new StorageError('InvalidArgument');
    }
    const { path: sourcePath, info: sourceInfo } = await this.locate(ref, signal);
    if (!sourceInfo.isFile() && !sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink()) {
      throw new StorageError('Unsupported');
    }
    const { path: parentPath, info: parentInfo } = await this.locate(parent, signal);
    if (!parentInfo.isDirectory()) throw new StorageError('InvalidArgument');
    if (
      sourceInfo.isDirectory() &&
      (parentPath === sourcePath || isLocalSubpath(sourcePath, parentPath))
    ) {
      throw new StorageError('InvalidArgument');
    }
    const sameParent = dirname(sourcePath) === parentPath;
    if (sameParent && basename(sourcePath) === name) {
      return this.toEntry(ref, name, sourcePath, sourceInfo, signal);
    }
    return this.performRename({
      sourcePath,
      sourceInfo,
      parentPath,
      name,
      sameParent,
      targetRef: { ...parent, locator: joinLocalLocator(parent.locator, name) },
      signal,
    });
  }

  private async performRename({
    sourcePath,
    sourceInfo,
    parentPath,
    name,
    sameParent,
    targetRef,
    signal,
  }: {
    sourcePath: string;
    sourceInfo: Stats;
    parentPath: string;
    name: string;
    sameParent: boolean;
    targetRef: EntryRef;
    signal: AbortSignal | undefined;
  }): Promise<Entry> {
    const targetPath = join(parentPath, name);
    try {
      const existing = await lstat(targetPath).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      let caseOnly =
        sameParent &&
        existing !== undefined &&
        basename(sourcePath).toLowerCase() === name.toLowerCase() &&
        existing.dev === sourceInfo.dev &&
        existing.ino === sourceInfo.ino;
      if (caseOnly && existing && existing.nlink > 1) {
        const siblings = await readdir(parentPath);
        caseOnly = !siblings.includes(name);
      }
      if (existing && !caseOnly) throw new StorageError('AlreadyExists');
      throwIfAborted(signal);
      await rename(sourcePath, targetPath);
      return await this.stat(targetRef, {});
    } catch (error) {
      localFailure(error, signal);
    }
  }

  async remove(ref: EntryRef, { signal }: OperationContext): Promise<void> {
    if (ref.locator === '.') throw new StorageError('InvalidArgument');
    const { path, info } = await this.locate(ref, signal);
    if (!info.isFile() && !info.isSymbolicLink() && !info.isDirectory()) {
      throw new StorageError('Unsupported');
    }
    try {
      throwIfAborted(signal);
      if (info.isDirectory()) await rm(path, { recursive: true });
      else await unlink(path);
    } catch (error) {
      localFailure(error, signal);
    }
  }

  async dispose() {}

  private locate(ref: EntryRef, signal?: AbortSignal) {
    return locateLocalEntry(ref, this.volumes, this.volumePaths, signal, this.platform);
  }

  private async toEntry(
    ref: EntryRef,
    name: string,
    displayPath: string,
    info: Dirent | Stats,
    signal?: AbortSignal,
  ): Promise<Entry> {
    const kind = entryKind(info);
    const directoryWrite =
      kind === 'directory'
        ? await resolveDirectoryWriteCapability(displayPath, this.platform)
        : unsupported;
    throwIfAborted(signal);
    const entry: Entry = {
      ref,
      name,
      kind,
      displayPath,
      capabilities: {
        ...localBaseCapabilities,
        list: kind === 'directory' ? supported : unsupported,
        write: directoryWrite,
        createDirectory: directoryWrite,
        copyWithin: ref.locator !== '.' && kind === 'file' ? supported : unsupported,
        moveWithin:
          ref.locator !== '.' && (kind === 'file' || kind === 'directory' || kind === 'link')
            ? supported
            : unsupported,
        rename: ref.locator === '.' ? unsupported : supported,
        remove:
          ref.locator !== '.' && (kind === 'file' || kind === 'link' || kind === 'directory')
            ? supported
            : unsupported,
      },
    };
    if ('mtime' in info) {
      const year = info.mtime.getUTCFullYear();
      if (year >= 0 && year <= 9999) entry.modifiedAt = info.mtime.toISOString();
      if (kind === 'file' && Number.isSafeInteger(info.size) && info.size >= 0)
        entry.size = info.size;
    }
    return entry;
  }
}

async function resolveDirectoryWriteCapability(
  path: string,
  platform: LocalPlatform,
): Promise<Capability> {
  if (platform.isWindows) return unknown;
  try {
    await access(path, constants.W_OK);
    return supported;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return unsupported;
    return unknown;
  }
}

function isLocalSubpath(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function entryKind(info: Dirent | Stats): Entry['kind'] {
  if (info.isDirectory()) return 'directory';
  if (info.isSymbolicLink()) return 'link';
  if (info.isFile()) return 'file';
  return 'other';
}
