import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StorageError } from '../../storage/core/errors';
import { DownloadError } from './download-paths';

export async function downloadTargetInfo(path: string): Promise<BigIntStats | undefined> {
  return lstat(path, { bigint: true }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
}

function sameDirectory(current: BigIntStats | undefined, expected: BigIntStats): boolean {
  return (
    current?.isDirectory() === true && current.dev === expected.dev && current.ino === expected.ino
  );
}

/** Holds directory identities, including the selected canonical destination. */
export class DownloadDirectories {
  private readonly identities = new Map<string, BigIntStats>();
  private readonly created = new Set<string>();

  async initialize(root: string): Promise<void> {
    const info = await downloadTargetInfo(root);
    if (!info?.isDirectory()) throw new DownloadError('InvalidDownloadDirectory');
    this.identities.set(root, info);
  }

  async assert(path: string): Promise<void> {
    const expected = this.identities.get(path);
    if (!expected || !sameDirectory(await downloadTargetInfo(path), expected))
      throw new StorageError('PreconditionFailed');
    const parent = dirname(path);
    if (this.identities.has(parent)) await this.assert(parent);
  }

  async ensure(path: string, replace: boolean): Promise<void> {
    await this.assert(dirname(path));
    if (this.identities.has(path)) {
      await this.assert(path);
      return;
    }
    let info = await downloadTargetInfo(path);
    if (info) {
      if (!info.isDirectory()) throw new DownloadError('InvalidDownloadName');
      if (!replace) throw new StorageError('AlreadyExists');
    } else {
      await mkdir(path);
      info = await downloadTargetInfo(path);
      if (!info?.isDirectory()) throw new StorageError('PreconditionFailed');
      this.created.add(path);
    }
    this.identities.set(path, info);
    await this.assert(path);
  }

  async cleanup(): Promise<void> {
    let failed = false;
    for (const path of [...this.created].reverse()) {
      const expected = this.identities.get(path);
      if (!expected) continue;
      try {
        await this.assert(dirname(path));
        if (sameDirectory(await downloadTargetInfo(path), expected)) await rmdir(path);
        this.created.delete(path);
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') failed = true;
      }
    }
    if (failed) throw new DownloadError('DownloadCleanupFailed');
  }
}
