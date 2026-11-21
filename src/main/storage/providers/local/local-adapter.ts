import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { constants, copyFile, lstat, mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, normalize, parse, sep } from 'node:path';
import type {
  Capabilities,
  CapabilityScope,
  CreateTarget,
  Entry,
  EntryPage,
  EntryRef,
  ListRequest,
  Space,
} from '@shared/storage';
import type { OperationContext } from '@main/storage/core/contracts';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import type { AdapterFactory, StorageAdapter } from '@main/storage/ports/adapter';
import { listLocalVolumes } from './local-volumes';

const supported = { support: 'supported' } as const;
const unsupported = { support: 'unsupported' } as const;
const unknown = { support: 'unknown' } as const;
const localBaseCapabilities: Capabilities = {
  list: supported,
  read: unsupported,
  write: unsupported,
  createDirectory: unknown,
  remove: supported,
  copyWithin: unknown,
  moveWithin: unsupported,
  rename: supported,
  rangeRead: unsupported,
  conditionalRead: unsupported,
  conditionalWrite: unsupported,
  resumeWrite: unsupported,
};
const metadataBatchSize = 32;

export function localSpace(connectionId: string, directory: string): Space {
  const path = normalize(directory);
  const id = createHash('sha256').update(path).digest('hex');
  return {
    id,
    connectionId,
    name: basename(path) || parse(path).root,
    root: { connectionId, spaceId: id, locator: '.' },
  };
}

export function localFailure(error: unknown, signal?: AbortSignal): never {
  throwIfAborted(signal);
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new StorageError('NotFound', { cause: error });
  if (code === 'EACCES' || code === 'EPERM') {
    throw new StorageError('PermissionDenied', { cause: error });
  }
  if (code === 'EEXIST' || code === 'ENOTEMPTY')
    throw new StorageError('AlreadyExists', { cause: error });
  if (code === 'EINVAL' || code === 'ENAMETOOLONG')
    throw new StorageError('InvalidArgument', { cause: error });
  throw error;
}

export function localAdapterFactory(
  folders: () => readonly string[],
  volumes: typeof listLocalVolumes = listLocalVolumes,
): AdapterFactory {
  return {
    provider: 'local',
    async create(connection) {
      return new LocalAdapter(connection.id, folders, volumes);
    },
  };
}

export async function locateLocalEntry(
  ref: EntryRef,
  folders: () => readonly string[],
  volumes: typeof listLocalVolumes = listLocalVolumes,
  cachedVolumes?: Map<string, string>,
  signal?: AbortSignal,
): Promise<{ path: string; info: Stats; kind: Entry['kind'] }> {
  throwIfAborted(signal);
  const names = ref.locator === '.' ? [] : ref.locator.split(sep);
  if (
    names.some(
      (name) =>
        !name ||
        name === '.' ||
        name === '..' ||
        name.includes('\0') ||
        (sep === '\\' && /[/:]|[. ]$/.test(name)),
    )
  ) {
    throw new StorageError('InvalidArgument');
  }

  const folder = folders().find((path) => localSpace(ref.connectionId, path).id === ref.spaceId);
  let path = folder ?? cachedVolumes?.get(ref.spaceId);
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
    private readonly folders: () => readonly string[],
    private readonly volumes: typeof listLocalVolumes,
  ) {}

  async listSpaces({ signal }: OperationContext): Promise<Space[]> {
    const paths = await this.volumes(signal);
    throwIfAborted(signal);
    this.volumePaths.clear();
    for (const path of paths) this.volumePaths.set(localSpace(this.connectionId, path).id, path);
    const spaces = new Map<string, Space>();
    for (const path of [...paths, ...this.folders()]) {
      const space = localSpace(this.connectionId, path);
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
    return localEntry(ref, basename(path) || parse(path).root, path, info);
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
            const ref = { ...parent, locator: join(parent.locator, item.name) };
            const displayPath = join(path, item.name);
            // A listed item can disappear or become inaccessible before metadata is read.
            const info = await lstat(displayPath).catch(() => undefined);
            return localEntry(ref, item.name, displayPath, info ?? item);
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
    if (ref.locator === '.' || !isValidLocalEntryName(name)) {
      throw new StorageError('InvalidArgument');
    }
    const { path, info } = await this.locate(ref, signal);
    if (basename(path) === name) return localEntry(ref, name, path, info);
    const target = join(dirname(path), name);
    try {
      const existing = await lstat(target).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
          return undefined;
        throw error;
      });
      const caseOnly =
        sep === '\\' &&
        basename(path).toLowerCase() === name.toLowerCase() &&
        existing?.dev === info.dev &&
        existing?.ino === info.ino;
      if (existing && !caseOnly) throw new StorageError('AlreadyExists');
      throwIfAborted(signal);
      await rename(path, target);
      return await this.stat({ ...ref, locator: join(dirname(ref.locator), name) }, {});
    } catch (error) {
      localFailure(error, signal);
    }
  }

  async createDirectory(
    { parent, name }: CreateTarget,
    { signal }: OperationContext,
  ): Promise<Entry> {
    if (!isValidLocalEntryName(name)) throw new StorageError('InvalidArgument');
    const { path: parentPath, info } = await this.locate(parent, signal);
    if (!info.isDirectory()) throw new StorageError('InvalidArgument');
    const targetPath = join(parentPath, name);
    try {
      throwIfAborted(signal);
      await mkdir(targetPath);
      return await this.stat(
        { ...parent, locator: join(parent.locator, name) },
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
    if (ref.locator === '.' || !isValidLocalEntryName(name)) {
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
        { ...parent, locator: join(parent.locator, name) },
        signal ? { signal } : {},
      );
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
    return locateLocalEntry(ref, this.folders, this.volumes, this.volumePaths, signal);
  }
}

function entryKind(info: Dirent | Stats): Entry['kind'] {
  if (info.isDirectory()) return 'directory';
  if (info.isSymbolicLink()) return 'link';
  if (info.isFile()) return 'file';
  return 'other';
}

function isValidLocalEntryName(name: string): boolean {
  return !(
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0') ||
    (sep === '\\' &&
      (/[<>:"\\|?*]|[. ]$/.test(name) ||
        Array.from(name).some((character) => character.charCodeAt(0) < 32) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))
  );
}

function localEntry(ref: EntryRef, name: string, displayPath: string, info: Dirent | Stats): Entry {
  const kind = entryKind(info);
  const entry: Entry = {
    ref,
    name,
    kind,
    displayPath,
    capabilities: {
      ...localBaseCapabilities,
      list: kind === 'directory' ? supported : unsupported,
      createDirectory: kind === 'directory' ? supported : unsupported,
      copyWithin: ref.locator !== '.' && kind === 'file' ? supported : unsupported,
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
