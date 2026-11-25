import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '@shared/storage';
import {
  createSelectionSummaryStore,
  sameSelectionSummary,
  summarizeSelection,
} from './selection-summary';

function createEntry(locator: string, kind: Entry['kind'], size?: number): Entry {
  return {
    ref: { connectionId: 'conn-1', spaceId: 'space-1', locator },
    name: locator,
    kind,
    size,
    capabilities: {},
  };
}

describe('summarizeSelection', () => {
  it('returns null for an empty selection', () => {
    expect(summarizeSelection([])).toBeNull();
  });

  it('sums exact sizes when all selected entries are files with known sizes', () => {
    const summary = summarizeSelection([
      createEntry('a.txt', 'file', 120),
      createEntry('b.txt', 'file', 380),
    ]);
    expect(summary).toEqual({ count: 2, sizeBytes: 500, estimated: false });
  });

  it('handles zero-byte files as exact known size', () => {
    const summary = summarizeSelection([createEntry('empty.txt', 'file', 0)]);
    expect(summary).toEqual({ count: 1, sizeBytes: 0, estimated: false });
  });

  it('omits size and marks estimated when only directories are selected', () => {
    const summary = summarizeSelection([
      createEntry('dir-a', 'directory'),
      createEntry('dir-b', 'directory', 4096),
    ]);
    expect(summary).toEqual({ count: 2, sizeBytes: undefined, estimated: true });
  });

  it('reports estimated size from known files when directories are also selected', () => {
    const summary = summarizeSelection([
      createEntry('dir-a', 'directory', 4096),
      createEntry('a.txt', 'file', 1024),
      createEntry('b.txt', 'file', 2048),
    ]);
    expect(summary).toEqual({ count: 3, sizeBytes: 3072, estimated: true });
  });

  it('marks estimated when a non-directory entry has unknown size', () => {
    expect(summarizeSelection([createEntry('doc', 'file')])).toEqual({
      count: 1,
      sizeBytes: undefined,
      estimated: true,
    });
    expect(
      summarizeSelection([createEntry('doc', 'file'), createEntry('a.txt', 'file', 512)]),
    ).toEqual({
      count: 2,
      sizeBytes: 512,
      estimated: true,
    });
  });

  it('omits size when total bytes overflow safe integers', () => {
    const summary = summarizeSelection([
      createEntry('huge-1', 'file', Number.MAX_SAFE_INTEGER),
      createEntry('huge-2', 'file', 1),
    ]);
    expect(summary).toEqual({ count: 2, sizeBytes: undefined, estimated: false });
  });
});

describe('createSelectionSummaryStore', () => {
  it('skips notifications when summary values are unchanged', () => {
    const store = createSelectionSummaryStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setSummary(null);
    expect(listener).not.toHaveBeenCalled();

    store.getState().setSummary({ count: 2, sizeBytes: 500, estimated: false });
    expect(listener).toHaveBeenCalledTimes(1);

    store.getState().setSummary({ count: 2, sizeBytes: 500, estimated: false });
    expect(listener).toHaveBeenCalledTimes(1);

    store.getState().setSummary({ count: 2, sizeBytes: 500, estimated: true });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(
      sameSelectionSummary(store.getState().summary, { count: 2, sizeBytes: 500, estimated: true }),
    ).toBe(true);
  });
});
