import type { Capabilities, ContentChecksum, Entry } from '@shared/storage';

export type TransferSourceKind = 'verifiable-reopenable' | 'unverifiable-sized' | 'one-shot';

export type TransferWriteStrategy = 'pausable-session' | 'single-pass-session' | 'one-shot-write';

export type TransferCompatibility =
  | {
      readonly supported: true;
      readonly sourceKind: TransferSourceKind;
      readonly strategy: TransferWriteStrategy;
      readonly pausable: boolean;
    }
  | {
      readonly supported: false;
      readonly code: 'Unsupported' | 'PermissionDenied';
    };

export function preferredChecksum(
  checksums: readonly ContentChecksum[] | undefined,
): ContentChecksum | undefined {
  if (!checksums || checksums.length === 0) return undefined;
  for (const algorithm of ['sha256', 'md5']) {
    const match = checksums.find((item) => item.algorithm === algorithm);
    if (match) return match;
  }
  return undefined;
}

export function classifyTransferSource(entry: Entry): TransferSourceKind {
  const hasRangeRead = entry.capabilities.rangeRead?.support === 'supported';
  const hasKnownSize =
    entry.size !== undefined && Number.isSafeInteger(entry.size) && entry.size >= 0;
  if (!hasRangeRead || !hasKnownSize) {
    return 'one-shot';
  }
  const checksum = preferredChecksum(entry.checksums);
  if (checksum !== undefined || entry.revision !== undefined) {
    return 'verifiable-reopenable';
  }
  return 'unverifiable-sized';
}

export function resolveTransferStrategy(
  sourceEntry: Entry,
  targetCapabilities: Capabilities,
  replace: boolean,
): TransferCompatibility {
  if (sourceEntry.kind !== 'file' || sourceEntry.capabilities.read?.support === 'unsupported') {
    return { supported: false, code: 'Unsupported' };
  }
  if (targetCapabilities.write?.support === 'unsupported') {
    return { supported: false, code: 'PermissionDenied' };
  }
  if (replace && targetCapabilities.replaceWrite?.support === 'unsupported') {
    return { supported: false, code: 'Unsupported' };
  }

  const sourceKind = classifyTransferSource(sourceEntry);
  const acceptsOneShot = targetCapabilities.streamingWrite?.support !== 'unsupported';
  const supportsSession = targetCapabilities.pausableWrite?.support !== 'unsupported';

  if (sourceKind === 'one-shot') {
    if (!acceptsOneShot) return { supported: false, code: 'Unsupported' };
    return { supported: true, sourceKind, strategy: 'one-shot-write', pausable: false };
  }

  if (sourceKind === 'unverifiable-sized') {
    if (acceptsOneShot) {
      return { supported: true, sourceKind, strategy: 'one-shot-write', pausable: false };
    }
    if (supportsSession) {
      return { supported: true, sourceKind, strategy: 'single-pass-session', pausable: false };
    }
    return { supported: false, code: 'Unsupported' };
  }

  // verifiable-reopenable
  if (supportsSession) {
    return { supported: true, sourceKind, strategy: 'pausable-session', pausable: true };
  }
  if (acceptsOneShot) {
    return { supported: true, sourceKind, strategy: 'one-shot-write', pausable: false };
  }
  return { supported: false, code: 'Unsupported' };
}
