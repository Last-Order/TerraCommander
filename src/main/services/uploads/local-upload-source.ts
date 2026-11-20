import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { ReopenableByteSource } from '@main/storage/core/contracts';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';

function localFileError(error: unknown, missing: 'NotFound' | 'SourceChanged'): never {
  if (error instanceof StorageError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') throw new StorageError(missing);
  if (code === 'EACCES' || code === 'EPERM') throw new StorageError('PermissionDenied');
  throw new StorageError('OutcomeUnknown', { cause: error });
}

function revision(stat: BigIntStats): string {
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

export async function prepareLocalUpload(path: string, allocatedName?: string) {
  const original = await lstat(path, { bigint: true }).catch((error: unknown) =>
    localFileError(error, 'NotFound'),
  );
  if (!original.isFile() || original.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StorageError('Unsupported');
  }
  const size = Number(original.size);
  const descriptor = {
    identity: identity(original),
    revision: revision(original),
    size,
    verification: 'weak',
  } as const;

  function assertUnchanged(stat: BigIntStats): void {
    if (
      !stat.isFile() ||
      identity(stat) !== descriptor.identity ||
      revision(stat) !== descriptor.revision
    ) {
      throw new StorageError('SourceChanged');
    }
  }

  const source: ReopenableByteSource = {
    kind: 'reopenable',
    size,
    descriptor,
    async open(range, { signal }) {
      throwIfAborted(signal);
      assertUnchanged(
        await lstat(path, { bigint: true }).catch((error: unknown) =>
          localFileError(error, 'SourceChanged'),
        ),
      );
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
      const handle = await open(path, flags).catch((error: unknown) =>
        localFileError(error, 'SourceChanged'),
      );
      const dispose = () => handle.close();
      const checkHandle = async () => {
        assertUnchanged(
          await handle
            .stat({ bigint: true })
            .catch((error: unknown) => localFileError(error, 'SourceChanged')),
        );
        throwIfAborted(signal);
      };
      try {
        await checkHandle();
        const start = range?.offset ?? 0;
        const length = range?.length ?? size - start;
        async function* read() {
          for (let offset = 0; offset < length;) {
            throwIfAborted(signal);
            const buffer = new Uint8Array(Math.min(64 * 1024, length - offset));
            const { bytesRead } = await handle
              .read(buffer, 0, buffer.length, start + offset)
              .catch((error: unknown) => localFileError(error, 'SourceChanged'));
            if (bytesRead === 0) throw new StorageError('SourceChanged');
            offset += bytesRead;
            yield buffer.subarray(0, bytesRead);
          }
          await checkHandle();
        }
        return { stream: Readable.from(read(), { objectMode: false }), length, dispose };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
  };
  return { name: allocatedName ?? basename(path), source };
}
