import { createHash, type Hash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageError, throwIfAborted } from '../storage/core/errors';
import { DownloadError, downloadFailure } from './download-paths';

export async function checkDownloadTarget(path: string, replace: boolean): Promise<void> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    downloadFailure(error);
  });
  if (existing && !existing.isFile()) throw new DownloadError('InvalidDownloadName');
  if (existing && !replace) throw new StorageError('AlreadyExists');
}

/** Owns the partial file and verifies it before reopening or publishing. */
export class DownloadOutput {
  private completedBytes = 0;
  private handle: FileHandle | undefined;
  private temporary: string | undefined;
  private identity: BigIntStats | undefined;
  private created = false;
  private ownershipLost = false;
  private readonly digest = createHash('sha256');
  private readonly contentDigest: Hash | undefined;

  constructor(
    readonly path: string,
    private readonly directory: string,
    private readonly replace: boolean,
    algorithm: string | undefined,
  ) {
    this.contentDigest = algorithm ? createHash(algorithm) : undefined;
  }

  get bytes(): number {
    return this.completedBytes;
  }

  get contentChecksum(): string | undefined {
    return this.contentDigest?.copy().digest('hex');
  }

  private get outputPath(): string {
    return this.temporary ? join(this.temporary, 'content') : this.path;
  }

  async open(signal: AbortSignal): Promise<void> {
    if (this.created) {
      await this.assertOwned();
      this.handle = await open(this.outputPath, 'r+');
      await this.verify(signal);
      return;
    }
    if (this.replace) {
      await checkDownloadTarget(this.path, true);
      this.temporary = await mkdtemp(join(this.directory, '.terra-download-'));
    }
    this.handle = await open(this.outputPath, 'wx+', 0o600);
    this.created = true;
    this.identity = await this.handle.stat({ bigint: true });
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.handle) throw new StorageError('InvalidArgument');
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(
        chunk,
        offset,
        chunk.byteLength - offset,
        this.bytes,
      );
      if (bytesWritten <= 0) throw new StorageError('OutcomeUnknown');
      const written = chunk.subarray(offset, offset + bytesWritten);
      this.digest.update(written);
      this.contentDigest?.update(written);
      this.completedBytes += bytesWritten;
      offset += bytesWritten;
    }
  }

  async verify(signal: AbortSignal): Promise<void> {
    if (!this.handle) throw new StorageError('InvalidArgument');
    await this.assertOwned();
    const before = await this.handle.stat({ bigint: true });
    if (!sameFile(before, this.identity) || before.size !== BigInt(this.bytes))
      this.lostOwnership();
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < this.bytes) {
      throwIfAborted(signal);
      const { bytesRead } = await this.handle.read(
        buffer,
        0,
        Math.min(buffer.length, this.bytes - offset),
        offset,
      );
      if (bytesRead === 0) this.lostOwnership();
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await this.handle.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      digest.digest('hex') !== this.digest.copy().digest('hex')
    )
      this.lostOwnership();
    await this.assertOwned();
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (!handle) return;
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async publish(): Promise<void> {
    await this.assertOwned();
    if (this.temporary) {
      await checkDownloadTarget(this.path, true);
      await rename(this.outputPath, this.path);
    }
  }

  async cleanup(completed: boolean): Promise<void> {
    if (this.temporary) await rm(this.temporary, { recursive: true, force: true });
    else if (!completed && this.created && !this.ownershipLost) {
      if (!this.identity) throw new DownloadError('DownloadCleanupFailed');
      if (sameFile(await fileIdentity(this.path), this.identity)) await unlink(this.path);
    }
  }

  private async assertOwned(): Promise<void> {
    if (!sameFile(await fileIdentity(this.outputPath), this.identity)) this.lostOwnership();
  }

  private lostOwnership(): never {
    this.ownershipLost = true;
    throw new StorageError('PreconditionFailed');
  }
}

function sameFile(current: BigIntStats | undefined, expected: BigIntStats | undefined): boolean {
  return (
    current !== undefined &&
    expected !== undefined &&
    current.isFile() &&
    current.dev === expected.dev &&
    current.ino === expected.ino
  );
}

async function fileIdentity(path: string): Promise<BigIntStats | undefined> {
  return lstat(path, { bigint: true }).catch((error: unknown) => {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return undefined;
    throw error;
  });
}
