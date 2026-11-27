import type {
  ByteSource,
  ReopenableByteSource,
  StreamingByteSource,
} from '@main/storage/core/contracts';
import {
  entryKey,
  type ContentChecksum,
  type Entry,
  type ReadOptions,
  type SourceDescriptor,
} from '@shared/storage';
import type { StorageFile } from '../storage/storage-file';
import {
  classifyTransferSource,
  preferredChecksum,
  type TransferSourceKind,
} from './transfer-compatibility';

export interface StorageFileByteSourceResult {
  readonly sourceKind: TransferSourceKind;
  readonly source: ByteSource;
  readonly checksum?: ContentChecksum | undefined;
}

/**
 * Adapts any StorageFile into a provider-neutral ByteSource.
 * open() strictly serves the requested byte range; whole-file checksum verification belongs to the
 * destination commit path, not per-chunk open() EOF.
 */
export function createStorageFileByteSource(
  file: StorageFile,
  entry: Entry,
): StorageFileByteSourceResult {
  const sourceKind = classifyTransferSource(entry);
  const checksum = preferredChecksum(entry.checksums);
  const conditionalRead =
    entry.capabilities.conditionalRead?.support === 'supported' && entry.revision !== undefined;

  if (sourceKind === 'one-shot') {
    const source: StreamingByteSource = {
      kind: 'one-shot',
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      open(_range, ctx) {
        const options: ReadOptions = conditionalRead ? { expectedRevision: entry.revision } : {};
        return file.read(options, ctx);
      },
    };
    return { sourceKind, source, ...(checksum ? { checksum } : {}) };
  }

  const size = entry.size!;
  const descriptor: SourceDescriptor = {
    identity: entryKey(entry.ref),
    revision: checksum
      ? `${checksum.algorithm}:${checksum.value.toLowerCase()}`
      : (entry.revision ?? `size:${size}`),
    size,
    verification: checksum ? 'strong' : 'weak',
    ...(checksum ? { checksum } : {}),
  };

  const source: ReopenableByteSource = {
    kind: 'reopenable',
    size,
    descriptor,
    open(range, ctx) {
      const options: ReadOptions = {
        ...(range ? { range } : {}),
        ...(conditionalRead ? { expectedRevision: entry.revision } : {}),
      };
      return file.read(options, ctx);
    },
    ...(sourceKind === 'verifiable-reopenable'
      ? {
          verify: async (expected, ctx) => {
            const current = await file.stat(ctx);
            if (current.kind !== 'file' || current.size !== expected.size) {
              return false;
            }
            if (expected.checksum) {
              const target = expected.checksum;
              return (
                current.checksums?.some(
                  (item) =>
                    item.algorithm === target.algorithm &&
                    item.value.toLowerCase() === target.value.toLowerCase(),
                ) ?? false
              );
            }
            return current.revision !== undefined && current.revision === expected.revision;
          },
        }
      : {}),
  };

  return { sourceKind, source, ...(checksum ? { checksum } : {}) };
}
