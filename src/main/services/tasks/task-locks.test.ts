import { describe, expect, it, vi } from 'vitest';
import { entryKey, type EntryRef } from '@shared/storage';
import { resolveTargetLockKeys, slotConflictKey, type TargetLockFacts } from './task-locks';

const targetParent: EntryRef = {
  connectionId: 'local',
  spaceId: 'vol-d',
  locator: 'docs/reports',
};

describe('task-locks', () => {
  it('normalizes slot conflict keys according to case sensitivity', () => {
    expect(slotConflictKey(targetParent, 'Report.pdf', false)).not.toBe(
      slotConflictKey(targetParent, 'report.pdf', false),
    );
    expect(slotConflictKey(targetParent, 'Report.pdf', true)).toBe(
      slotConflictKey(targetParent, 'report.pdf', true),
    );
  });

  it('builds exclusive slot locks and deduplicated shared ancestor locks', async () => {
    const facts: TargetLockFacts = {
      spaceSemantics: vi.fn(async () => ({ allowsDuplicateNames: false, caseSensitive: false })),
      ancestorLocators: vi.fn(async () => ['docs/reports', 'docs', '.']),
    };

    const locks = await resolveTargetLockKeys(facts, targetParent, ['Report.pdf', 'notes.txt']);

    expect(locks).toEqual({
      exclusive: [
        slotConflictKey(targetParent, 'report.pdf', true),
        slotConflictKey(targetParent, 'notes.txt', true),
      ],
      shared: [
        entryKey(targetParent),
        entryKey({ ...targetParent, locator: 'docs' }),
        entryKey({ ...targetParent, locator: '.' }),
      ],
    });
  });

  it('skips target locks and ancestor lookups when the space allows duplicate names', async () => {
    const ancestorLocators = vi.fn<TargetLockFacts['ancestorLocators']>(async () => ['root']);
    const facts: TargetLockFacts = {
      spaceSemantics: vi.fn(async () => ({ allowsDuplicateNames: true })),
      ancestorLocators,
    };

    const locks = await resolveTargetLockKeys(facts, targetParent, ['Report.pdf']);

    expect(locks).toEqual({ exclusive: [], shared: [] });
    expect(ancestorLocators).not.toHaveBeenCalled();
  });

  it('retains a shared lock on the target directory itself when ancestor lookup fails', async () => {
    const facts: TargetLockFacts = {
      spaceSemantics: vi.fn(async () => ({ allowsDuplicateNames: false, caseSensitive: true })),
      ancestorLocators: vi.fn(async () => {
        throw new Error('transient lookup error');
      }),
    };

    const locks = await resolveTargetLockKeys(facts, targetParent, ['Report.pdf']);

    expect(locks).toEqual({
      exclusive: [slotConflictKey(targetParent, 'Report.pdf', false)],
      shared: [entryKey(targetParent)],
    });
  });
});
