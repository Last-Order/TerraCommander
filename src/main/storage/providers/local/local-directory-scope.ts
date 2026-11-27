import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  DirectoryScope,
  EnsureDirectoryResult,
  OperationContext,
} from '@main/storage/core/contracts';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import type { Entry, EntryRef } from '@shared/storage';
import { joinLocalLocator, type LocalPlatform } from './local-platform';

const localScopeBrand = Symbol('LocalDirectoryScope');

async function statBigInt(path: string): Promise<BigIntStats | undefined> {
  return lstat(path, { bigint: true }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
}

function sameDirectory(current: BigIntStats | undefined, expected: BigIntStats): boolean {
  return (
    current?.isDirectory() === true && current.dev === expected.dev && current.ino === expected.ino
  );
}

export interface LocalDirectoryScopeDeps {
  locate(
    ref: EntryRef,
    signal?: AbortSignal,
  ): Promise<{ path: string; info: BigIntStats; kind: Entry['kind'] }>;
  toEntry(
    ref: EntryRef,
    name: string,
    displayPath: string,
    info: BigIntStats,
    signal?: AbortSignal,
  ): Promise<Entry>;
  platform: LocalPlatform;
  mapError(error: unknown, signal?: AbortSignal): never;
}

export interface LocalDirectoryScope extends DirectoryScope {
  readonly [localScopeBrand]: true;
  assertDirectoryPath(path: string, signal?: AbortSignal): Promise<void>;
}

export function isLocalDirectoryScope(
  scope: DirectoryScope | undefined,
): scope is LocalDirectoryScope {
  return scope !== undefined && localScopeBrand in scope;
}

/** Pins local directory (dev, ino) identities across a transfer and atomically removes created empty dirs. */
export async function createLocalDirectoryScope(
  root: EntryRef,
  deps: LocalDirectoryScopeDeps,
  context: OperationContext = {},
): Promise<LocalDirectoryScope> {
  const locatedRoot = await deps.locate(root, context.signal);
  if (locatedRoot.kind !== 'directory') {
    throw new StorageError('InvalidArgument');
  }

  const identities = new Map<string, BigIntStats>([[locatedRoot.path, locatedRoot.info]]);
  const created: string[] = [];

  async function assertDirectoryPath(path: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const expected = identities.get(path);
    if (!expected) {
      throw new StorageError('PreconditionFailed');
    }
    const current = await statBigInt(path).catch((error: unknown) => deps.mapError(error, signal));
    throwIfAborted(signal);
    if (!sameDirectory(current, expected)) {
      throw new StorageError('PreconditionFailed');
    }
    const parent = dirname(path);
    if (parent !== path && identities.has(parent)) {
      await assertDirectoryPath(parent, signal);
    }
  }

  return {
    [localScopeBrand]: true,
    root,

    async assertDirectoryPath(path, signal) {
      await assertDirectoryPath(path, signal);
    },

    async assertValid(dir, ctx = {}) {
      const located = await deps.locate(dir, ctx.signal).catch((error: unknown) => {
        if (error instanceof StorageError && error.code === 'NotFound') {
          throw new StorageError('PreconditionFailed');
        }
        throw error;
      });
      await assertDirectoryPath(located.path, ctx.signal);
    },

    async ensureDirectory(parent, name, { replace }, ctx = {}): Promise<EnsureDirectoryResult> {
      throwIfAborted(ctx.signal);
      if (!deps.platform.isValidEntryName(name)) {
        throw new StorageError('InvalidArgument');
      }
      const locatedParent = await deps.locate(parent, ctx.signal);
      if (locatedParent.kind !== 'directory') {
        throw new StorageError('InvalidArgument');
      }
      await assertDirectoryPath(locatedParent.path, ctx.signal);

      const targetPath = join(locatedParent.path, name);
      const targetRef: EntryRef = {
        ...parent,
        locator: joinLocalLocator(parent.locator, name),
      };

      if (identities.has(targetPath)) {
        await assertDirectoryPath(targetPath, ctx.signal);
        const existingInfo = identities.get(targetPath)!;
        const entry = await deps.toEntry(targetRef, name, targetPath, existingInfo, ctx.signal);
        return { entry, created: false };
      }

      try {
        let info = await statBigInt(targetPath);
        let wasCreated = false;
        if (info) {
          // Never traverse into a symlink, junction, or file when expecting a directory.
          if (!info.isDirectory()) throw new StorageError('InvalidArgument');
          if (!replace) throw new StorageError('AlreadyExists');
        } else {
          throwIfAborted(ctx.signal);
          await mkdir(targetPath);
          info = await statBigInt(targetPath);
          if (!info?.isDirectory()) throw new StorageError('PreconditionFailed');
          created.push(targetPath);
          wasCreated = true;
        }
        identities.set(targetPath, info);
        await assertDirectoryPath(targetPath, ctx.signal);
        const entry = await deps.toEntry(targetRef, name, targetPath, info, ctx.signal);
        return { entry, created: wasCreated };
      } catch (error) {
        deps.mapError(error, ctx.signal);
      }
    },

    async cleanupCreated(ctx = {}): Promise<void> {
      let failed = false;
      for (const path of [...created].reverse()) {
        const expected = identities.get(path);
        if (!expected) continue;
        try {
          await assertDirectoryPath(dirname(path), ctx.signal);
          if (sameDirectory(await statBigInt(path), expected)) {
            await rmdir(path);
          }
          const index = created.indexOf(path);
          if (index >= 0) created.splice(index, 1);
        } catch (error) {
          const code =
            error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') {
            failed = true;
          }
        }
      }
      if (failed) throw new StorageError('OutcomeUnknown');
    },
  };
}
