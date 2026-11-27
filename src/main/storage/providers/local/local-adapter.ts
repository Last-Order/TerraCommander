import { createHash } from 'node:crypto';
import type { BigIntStats, Dirent } from 'node:fs';
import {
  access,
  constants,
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, normalize, parse } from 'node:path';
import type {
  AdapterWriteSession,
  ByteSource,
  DirectoryScope,
  OperationContext,
  ReadHandle,
  WriteOptions,
} from '@main/storage/core/contracts';
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
  ReadOptions,
  RemoveOptions,
  SourceDescriptor,
  Space,
  SpaceSemantics,
  WriteTarget,
} from '@shared/storage';
import { createLocalDirectoryScope, isLocalDirectoryScope } from './local-directory-scope';
import {
  defaultLocalPlatform,
  joinLocalLocator,
  parentLocalLocator,
  splitLocalLocator,
  type LocalPlatform,
} from './local-platform';
import {
  hashLocalFile,
  localDirectoryRevision,
  localFileRevision,
  readLocalFile,
} from './local-read';
import { listLocalVolumes } from './local-volumes';
import { createLocalWriteSession, writeLocalFile, type LocalWriteSpec } from './local-write';

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
  read: supported,
  write: unknown,
  streamingWrite: supported,
  pausableWrite: supported,
  replaceWrite: supported,
  createDirectory: unknown,
  remove: supported,
  copyWithin: unknown,
  moveWithin: unknown,
  rename: supported,
  rangeRead: supported,
  conditionalRead: supported,
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
): Promise<{ path: string; info: BigIntStats; kind: Entry['kind'] }> {
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
    let info = await lstat(path, { bigint: true });
    for (const name of names) {
      // Directory traversal never follows a symlink or junction.
      if (!info.isDirectory()) throw new StorageError('NotFound');
      throwIfAborted(signal);
      path = join(path, name);
      info = await lstat(path, { bigint: true });
    }
    throwIfAborted(signal);
    return { path, info, kind: entryKind(info) };
  } catch (error) {
    localFailure(error, signal);
  }
}

export async function inspectLocalTransfer(
  target: EntryRef,
  sources: readonly { ref: EntryRef; kind: Entry['kind'] }[],
  mode: 'copy' | 'move',
  volumes: typeof listLocalVolumes = listLocalVolumes,
  platform: LocalPlatform = defaultLocalPlatform,
  signal?: AbortSignal,
): Promise<{ selfContained: boolean; moveStrategy: 'native' | 'copy-delete' }> {
  throwIfAborted(signal);
  const cachedVolumes = new Map<string, string>();
  const locatedTarget = await locateLocalEntry(target, volumes, cachedVolumes, signal, platform);
  if (locatedTarget.kind !== 'directory') {
    throw new StorageError('InvalidArgument');
  }

  let moveStrategy: 'native' | 'copy-delete' = 'native';
  for (const source of sources) {
    if (mode === 'copy' && source.kind !== 'directory') continue;
    const locatedSource = await locateLocalEntry(
      source.ref,
      volumes,
      cachedVolumes,
      signal,
      platform,
    );
    if (
      locatedSource.kind === 'directory' &&
      platform.isSameOrSubpath(locatedSource.path, locatedTarget.path)
    ) {
      return { selfContained: true, moveStrategy: 'native' };
    }
    if (mode === 'move' && locatedTarget.info.dev !== locatedSource.info.dev) {
      moveStrategy = 'copy-delete';
    }
  }
  return { selfContained: false, moveStrategy };
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
            const info = await lstat(displayPath, { bigint: true }).catch(() => undefined);
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

  async read(
    ref: EntryRef,
    options: ReadOptions,
    { signal }: OperationContext,
  ): Promise<ReadHandle> {
    if (ref.locator === '.') throw new StorageError('Unsupported');
    const { path, info } = await this.locate(ref, signal);
    return readLocalFile(path, info, options, signal);
  }

  async write(
    target: WriteTarget,
    source: ByteSource,
    context: OperationContext,
    options?: WriteOptions,
  ): Promise<Entry> {
    const spec = await this.resolveWriteSpec(target, context.signal, options);
    return writeLocalFile(spec, source, context);
  }

  async prepareWrite(
    target: WriteTarget,
    source: SourceDescriptor,
    context: OperationContext,
    options?: WriteOptions,
  ): Promise<AdapterWriteSession> {
    const spec = await this.resolveWriteSpec(target, context.signal, options);
    return createLocalWriteSession(spec, source.size, source.checksum);
  }

  openDirectoryScope(root: EntryRef, context: OperationContext): Promise<DirectoryScope> {
    return createLocalDirectoryScope(
      root,
      {
        locate: (ref, signal) => this.locate(ref, signal),
        toEntry: (ref, name, displayPath, info, signal) =>
          this.toEntry(ref, name, displayPath, info, signal),
        platform: this.platform,
        mapError: (error, signal) => localFailure(error, signal),
      },
      context,
    );
  }

  private async resolveWriteSpec(
    target: WriteTarget,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<LocalWriteSpec> {
    throwIfAborted(signal);
    const directoryScope = isLocalDirectoryScope(options?.directoryScope)
      ? options.directoryScope
      : undefined;
    if (target.kind === 'create') {
      if (!this.platform.isValidEntryName(target.name)) {
        throw new StorageError('InvalidArgument');
      }
      const { path: parentPath, info } = await this.locate(target.parent, signal);
      if (!info.isDirectory()) throw new StorageError('InvalidArgument');
      const targetPath = join(parentPath, target.name);
      const targetRef: EntryRef = {
        ...target.parent,
        locator: joinLocalLocator(target.parent.locator, target.name),
      };
      return {
        parentPath,
        targetPath,
        targetRef,
        replace: false,
        directoryScope,
        statTarget: (ref, opSignal) => this.stat(ref, opSignal ? { signal: opSignal } : {}),
        mapError: (error, opSignal) => localFailure(error, opSignal),
      };
    }

    if (target.policy === 'replace-if-version') {
      throw new StorageError('Unsupported');
    }
    if (target.ref.locator === '.') {
      throw new StorageError('InvalidArgument');
    }
    const segments = splitLocalLocator(target.ref.locator);
    const name = segments.at(-1);
    if (!name || !this.platform.isValidEntryName(name)) {
      throw new StorageError('InvalidArgument');
    }
    const parentRef: EntryRef = {
      ...target.ref,
      locator: parentLocalLocator(target.ref.locator),
    };
    const { path: parentPath, info } = await this.locate(parentRef, signal);
    if (!info.isDirectory()) throw new StorageError('InvalidArgument');
    return {
      parentPath,
      targetPath: join(parentPath, name),
      targetRef: target.ref,
      replace: true,
      directoryScope,
      statTarget: (ref, opSignal) => this.stat(ref, opSignal ? { signal: opSignal } : {}),
      mapError: (error, opSignal) => localFailure(error, opSignal),
    };
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
    if (sourceInfo.isDirectory() && this.platform.isSameOrSubpath(sourcePath, parentPath)) {
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
    sourceInfo: BigIntStats;
    parentPath: string;
    name: string;
    sameParent: boolean;
    targetRef: EntryRef;
    signal: AbortSignal | undefined;
  }): Promise<Entry> {
    const targetPath = join(parentPath, name);
    try {
      const existing = await lstat(targetPath, { bigint: true }).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      let caseOnly =
        sameParent &&
        existing !== undefined &&
        basename(sourcePath).toLowerCase() === name.toLowerCase() &&
        existing.dev === sourceInfo.dev &&
        existing.ino === sourceInfo.ino;
      if (caseOnly && existing && existing.nlink > 1n) {
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

  async remove(
    ref: EntryRef,
    { signal }: OperationContext,
    options?: RemoveOptions,
  ): Promise<void> {
    if (ref.locator === '.') throw new StorageError('InvalidArgument');
    const { path, info } = await this.locate(ref, signal);
    if (!info.isFile() && !info.isSymbolicLink() && !info.isDirectory()) {
      throw new StorageError('Unsupported');
    }
    if (options?.expectedRevision !== undefined) {
      let currentRevision: string | undefined;
      if (info.isFile()) currentRevision = localFileRevision(info);
      else if (info.isDirectory()) currentRevision = localDirectoryRevision(info);
      if (currentRevision !== options.expectedRevision) {
        throw new StorageError('SourceChanged');
      }
    }
    if (options?.expectedSize !== undefined) {
      if (!info.isFile() || info.size !== BigInt(options.expectedSize)) {
        throw new StorageError('SourceChanged');
      }
    }
    if (options?.expectedChecksum !== undefined) {
      if (!info.isFile()) throw new StorageError('SourceChanged');
      const actual = await hashLocalFile(path, options.expectedChecksum.algorithm, info, signal);
      if (actual.toLowerCase() !== options.expectedChecksum.value.toLowerCase()) {
        throw new StorageError('SourceChanged');
      }
    }
    try {
      throwIfAborted(signal);
      if (info.isDirectory()) {
        if (options?.onlyIfEmpty) {
          await rmdir(path).catch((error: unknown) => {
            const code = errorCode(error);
            if (code === 'ENOTEMPTY' || code === 'EEXIST') {
              throw new StorageError('PreconditionFailed', { cause: error, providerCode: code });
            }
            throw error;
          });
        } else {
          await rm(path, { recursive: true });
        }
      } else {
        await unlink(path);
      }
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
    info: Dirent | BigIntStats,
    signal?: AbortSignal,
  ): Promise<Entry> {
    const kind = entryKind(info);
    const directoryWrite =
      kind === 'directory'
        ? await resolveDirectoryWriteCapability(displayPath, this.platform)
        : unsupported;
    throwIfAborted(signal);
    const fileRead = kind === 'file' ? supported : unsupported;
    let replaceWrite: Capability = unsupported;
    if (kind === 'directory') replaceWrite = directoryWrite;
    else if (kind === 'file') replaceWrite = supported;
    const entry: Entry = {
      ref,
      name,
      kind,
      displayPath,
      capabilities: {
        ...localBaseCapabilities,
        list: kind === 'directory' ? supported : unsupported,
        read: fileRead,
        rangeRead: fileRead,
        conditionalRead: fileRead,
        write: directoryWrite,
        streamingWrite: directoryWrite,
        pausableWrite: directoryWrite,
        replaceWrite,
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
      if (kind === 'file') {
        if (info.size >= 0n && info.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
          entry.size = Number(info.size);
        }
        entry.revision = localFileRevision(info);
      } else if (kind === 'directory') {
        entry.revision = localDirectoryRevision(info);
      }
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

function entryKind(info: Dirent | BigIntStats): Entry['kind'] {
  if (info.isDirectory()) return 'directory';
  if (info.isSymbolicLink()) return 'link';
  if (info.isFile()) return 'file';
  return 'other';
}
