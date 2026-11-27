import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadHandle } from '@main/storage/core/contracts';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import type { ReadOptions } from '@shared/storage';

const readChunkSize = 64 * 1024;

export function localFileRevision(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export function localDirectoryRevision(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

function readFailure(error: unknown, missing: 'NotFound' | 'SourceChanged'): never {
  if (error instanceof StorageError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') throw new StorageError(missing);
  if (code === 'EACCES' || code === 'EPERM') throw new StorageError('PermissionDenied');
  throw new StorageError('OutcomeUnknown', { cause: error });
}

function assertFileUnchanged(stat: BigIntStats, expectedRevision: string): void {
  if (!stat.isFile() || localFileRevision(stat) !== expectedRevision) {
    throw new StorageError('SourceChanged');
  }
}

export async function readLocalFile(
  path: string,
  expectedStat: BigIntStats,
  options: ReadOptions,
  signal?: AbortSignal,
): Promise<ReadHandle> {
  throwIfAborted(signal);
  if (!expectedStat.isFile() || expectedStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StorageError('Unsupported');
  }
  const revision = localFileRevision(expectedStat);
  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
    throw new StorageError('PreconditionFailed');
  }

  const size = Number(expectedStat.size);
  const start = options.range?.offset ?? 0;
  if (start > size) {
    throw new StorageError('InvalidArgument');
  }
  const available = size - start;
  const length =
    options.range?.length !== undefined ? Math.min(options.range.length, available) : available;

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags).catch((error: unknown) =>
    readFailure(error, 'SourceChanged'),
  );

  let disposed = false;
  let stream: Readable | undefined;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    stream?.destroy();
    await handle.close().catch(() => {});
  };

  const checkHandle = async () => {
    const current = await handle
      .stat({ bigint: true })
      .catch((error: unknown) => readFailure(error, 'SourceChanged'));
    assertFileUnchanged(current, revision);
    throwIfAborted(signal);
  };

  try {
    await checkHandle();
    async function* readChunks() {
      try {
        for (let offset = 0; offset < length;) {
          throwIfAborted(signal);
          const buffer = new Uint8Array(Math.min(readChunkSize, length - offset));
          const { bytesRead } = await handle
            .read(buffer, 0, buffer.length, start + offset)
            .catch((error: unknown) => readFailure(error, 'SourceChanged'));
          if (bytesRead === 0) throw new StorageError('SourceChanged');
          offset += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
        await checkHandle();
      } finally {
        if (!disposed) {
          disposed = true;
          await handle.close().catch(() => {});
        }
      }
    }
    stream = Readable.from(readChunks(), { objectMode: false });
    stream.on('error', () => {});
    return { stream, length, revision, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function hashLocalFile(
  path: string,
  algorithm: string,
  expectedStat: BigIntStats,
  signal?: AbortSignal,
): Promise<string> {
  const handle = await readLocalFile(path, expectedStat, {}, signal);
  const hash = createHash(algorithm);
  try {
    for await (const chunk of handle.stream) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) throw new StorageError('OutcomeUnknown');
      hash.update(chunk);
    }
    return hash.digest('hex');
  } finally {
    await handle.dispose();
  }
}
