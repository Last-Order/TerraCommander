import { describe, expect, it } from 'vitest';
import type { Capabilities, Entry } from '@shared/storage';
import { classifyTransferSource, resolveTransferStrategy } from './transfer-compatibility';
import { allocateTransferNames } from './transfer-names';

function makeFile(overrides: Partial<Entry> = {}): Entry {
  return {
    ref: { connectionId: 'src', spaceId: 's', locator: 'f1' },
    name: 'file.bin',
    kind: 'file',
    size: 100,
    capabilities: {
      read: { support: 'supported' },
      rangeRead: { support: 'supported' },
    },
    ...overrides,
  };
}

const localCaps: Capabilities = {
  write: { support: 'unknown' },
  streamingWrite: { support: 'supported' },
  pausableWrite: { support: 'supported' },
  replaceWrite: { support: 'supported' },
};

const driveCaps: Capabilities = {
  write: { support: 'supported' },
  streamingWrite: { support: 'unsupported' },
  pausableWrite: { support: 'supported' },
  replaceWrite: { support: 'unsupported' },
};

describe('transfer compatibility matrix', () => {
  it('classifies sources accurately by rangeRead, size, and verifiable version', () => {
    expect(
      classifyTransferSource(
        makeFile({ checksums: [{ algorithm: 'sha256', value: 'a'.repeat(64) }] }),
      ),
    ).toBe('verifiable-reopenable');
    expect(classifyTransferSource(makeFile({ revision: 'dev:ino:100:1:1' }))).toBe(
      'verifiable-reopenable',
    );
    expect(classifyTransferSource(makeFile())).toBe('unverifiable-sized');
    expect(classifyTransferSource(makeFile({ size: undefined }))).toBe('one-shot');
    expect(
      classifyTransferSource(
        makeFile({
          capabilities: { read: { support: 'supported' }, rangeRead: { support: 'unsupported' } },
        }),
      ),
    ).toBe('one-shot');
  });

  it('rejects one-shot sources against streamingWrite: unsupported targets at planning time', () => {
    const oneShot = makeFile({ size: undefined });
    expect(resolveTransferStrategy(oneShot, driveCaps, false)).toEqual({
      supported: false,
      code: 'Unsupported',
    });
    expect(resolveTransferStrategy(oneShot, localCaps, false)).toEqual({
      supported: true,
      sourceKind: 'one-shot',
      strategy: 'one-shot-write',
      pausable: false,
    });
  });

  it('downgrades unverifiable-sized sources to non-pausable and enables pause for verifiable sources', () => {
    const unverifiable = makeFile();
    expect(resolveTransferStrategy(unverifiable, localCaps, false)).toEqual({
      supported: true,
      sourceKind: 'unverifiable-sized',
      strategy: 'one-shot-write',
      pausable: false,
    });
    expect(resolveTransferStrategy(unverifiable, driveCaps, false)).toEqual({
      supported: true,
      sourceKind: 'unverifiable-sized',
      strategy: 'single-pass-session',
      pausable: false,
    });

    const verifiable = makeFile({ revision: 'v1' });
    expect(resolveTransferStrategy(verifiable, driveCaps, false)).toEqual({
      supported: true,
      sourceKind: 'verifiable-reopenable',
      strategy: 'pausable-session',
      pausable: true,
    });
    expect(resolveTransferStrategy(verifiable, localCaps, true)).toEqual({
      supported: true,
      sourceKind: 'verifiable-reopenable',
      strategy: 'pausable-session',
      pausable: true,
    });
    expect(resolveTransferStrategy(verifiable, driveCaps, true)).toEqual({
      supported: false,
      code: 'Unsupported',
    });
  });
});

describe('allocateTransferNames', () => {
  it('respects target SpaceSemantics for duplicate allowance and case sensitivity', () => {
    const entries = [
      { name: 'Report.pdf', kind: 'file' as const },
      { name: 'report.pdf', kind: 'file' as const },
      { name: 'Docs', kind: 'directory' as const },
      { name: 'Docs', kind: 'directory' as const },
    ];
    expect(allocateTransferNames(entries, { allowsDuplicateNames: true })).toEqual([
      'Report.pdf',
      'report.pdf',
      'Docs',
      'Docs',
    ]);
    expect(
      allocateTransferNames(entries, { allowsDuplicateNames: false, caseSensitive: false }),
    ).toEqual(['Report (1).pdf', 'report (2).pdf', 'Docs (1)', 'Docs (2)']);
    expect(
      allocateTransferNames(entries, { allowsDuplicateNames: false, caseSensitive: true }),
    ).toEqual(['Report.pdf', 'report.pdf', 'Docs (1)', 'Docs (2)']);
  });
});
