import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, normalize, parse, sep } from 'node:path';
import type { Entry, EntryPage, EntryRef, ListRequest, Space } from '../../../../shared/storage';
import type { OperationContext } from '../../core/contracts';
import { StorageError, throwIfAborted } from '../../core/errors';
import type { AdapterFactory, StorageAdapter } from '../../ports/adapter';
import { listLocalVolumes } from './local-volumes';

const listSupported = { list: { support: 'supported' } } as const;
const renameSupported = { rename: { support: 'supported' } } as const;
const removeSupported = { remove: { support: 'supported' } } as const;
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

  async capabilities() {
    return { ...listSupported, ...renameSupported, ...removeSupported };
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
    if (
      ref.locator === '.' ||
      !name.trim() ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\0') ||
      (sep === '\\' &&
        (/[<>:"\\|?*]|[. ]$/.test(name) ||
          Array.from(name).some((character) => character.charCodeAt(0) < 32) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))
    ) {
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

  async remove(ref: EntryRef, { signal }: OperationContext): Promise<void> {
    if (ref.locator === '.') throw new StorageError('InvalidArgument');
    const { path, info } = await this.locate(ref, signal);
    if (!info.isFile() && !info.isSymbolicLink()) throw new StorageError('Unsupported');
    try {
      throwIfAborted(signal);
      await unlink(path);
    } catch (error) {
      localFailure(error, signal);
    }
  }

  async dispose() {}

  private async locate(ref: EntryRef, signal?: AbortSignal) {
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

    const folder = this.folders().find(
      (path) => localSpace(this.connectionId, path).id === ref.spaceId,
    );
    if (!folder && !this.volumePaths.has(ref.spaceId))
      await this.listSpaces(signal ? { signal } : {});
    let path = folder ?? this.volumePaths.get(ref.spaceId);
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
      return { path, info };
    } catch (error) {
      localFailure(error, signal);
    }
  }
}

function localEntry(ref: EntryRef, name: string, displayPath: string, info: Dirent | Stats): Entry {
  let kind: Entry['kind'] = 'other';
  if (info.isDirectory()) kind = 'directory';
  else if (info.isSymbolicLink()) kind = 'link';
  else if (info.isFile()) kind = 'file';
  const entry: Entry = {
    ref,
    name,
    kind,
    displayPath,
    capabilities:
      ref.locator === '.'
        ? kind === 'directory'
          ? listSupported
          : {}
        : {
            ...renameSupported,
            ...(kind === 'directory' ? listSupported : {}),
            ...(kind === 'file' || kind === 'link' ? removeSupported : {}),
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
