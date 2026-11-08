import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, normalize, parse, sep } from 'node:path';
import type { Entry, EntryPage, EntryRef, ListRequest, Space } from '../../../../shared/storage';
import type { OperationContext } from '../../core/contracts';
import { StorageError, throwIfAborted } from '../../core/errors';
import type { AdapterFactory, StorageAdapter } from '../../ports/adapter';
import { listLocalVolumes } from './local-volumes';

const listSupported = { list: { support: 'supported' } } as const;

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
    return listSupported;
  }

  async stat(ref: EntryRef, { signal }: OperationContext): Promise<Entry> {
    const { path, info } = await this.locate(ref, signal);
    const entry = localEntry(ref, basename(path) || parse(path).root, info);
    if (entry.kind === 'file' && Number.isSafeInteger(info.size)) entry.size = info.size;
    return entry;
  }

  async list(
    parent: EntryRef,
    { pageSize = 100, cursor }: ListRequest,
    { signal }: OperationContext,
  ): Promise<EntryPage> {
    const { path, info } = await this.locate(parent, signal);
    if (!info.isDirectory()) throw new StorageError('InvalidArgument');

    try {
      const items = await readdir(path, { withFileTypes: true });
      throwIfAborted(signal);
      items.sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
      const start = cursor === undefined ? 0 : items.findIndex(({ name }) => name > cursor);
      if (start < 0) return { entries: [] };
      const page = items.slice(start, start + pageSize);
      const entries = page.map((item) =>
        localEntry({ ...parent, locator: join(parent.locator, item.name) }, item.name, item),
      );
      const last = page.at(-1);
      return last && start + page.length < items.length
        ? { entries, nextCursor: last.name }
        : { entries };
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

function localEntry(ref: EntryRef, name: string, info: Dirent | Stats): Entry {
  let kind: Entry['kind'] = 'other';
  if (info.isDirectory()) kind = 'directory';
  else if (info.isSymbolicLink()) kind = 'link';
  else if (info.isFile()) kind = 'file';
  return { ref, name, kind, capabilities: kind === 'directory' ? listSupported : {} };
}
