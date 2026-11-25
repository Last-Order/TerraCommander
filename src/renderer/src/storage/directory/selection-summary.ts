import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Entry } from '@shared/storage';

export interface SelectionSummary {
  count: number;
  /** Sum of known non-directory entry sizes in bytes, or undefined when unavailable or overflowing. */
  sizeBytes: number | undefined;
  /** True when the selection includes directories or non-directory entries without a known size. */
  estimated: boolean;
}

export interface SelectionSummaryState {
  summary: SelectionSummary | null;
  setSummary: (summary: SelectionSummary | null) => void;
}

export type SelectionSummaryStore = StoreApi<SelectionSummaryState>;

export function sameSelectionSummary(
  left: SelectionSummary | null,
  right: SelectionSummary | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.count === right.count &&
    left.sizeBytes === right.sizeBytes &&
    left.estimated === right.estimated
  );
}

export function summarizeSelection(entries: readonly Entry[]): SelectionSummary | null {
  if (entries.length === 0) return null;

  let knownBytes = 0;
  let hasKnownSize = false;
  let estimated = false;
  let overflow = false;

  for (const entry of entries) {
    if (entry.kind === 'directory') {
      estimated = true;
      continue;
    }
    if (entry.size === undefined) {
      estimated = true;
      continue;
    }
    hasKnownSize = true;
    if (!overflow) {
      const next = knownBytes + entry.size;
      if (entry.size >= 0 && Number.isSafeInteger(next)) {
        knownBytes = next;
      } else {
        overflow = true;
      }
    }
  }

  return {
    count: entries.length,
    sizeBytes: hasKnownSize && !overflow ? knownBytes : undefined,
    estimated,
  };
}

export function createSelectionSummaryStore(): SelectionSummaryStore {
  return createStore<SelectionSummaryState>((set) => ({
    summary: null,
    setSummary: (summary) =>
      set((state) => (sameSelectionSummary(state.summary, summary) ? state : { summary })),
  }));
}
