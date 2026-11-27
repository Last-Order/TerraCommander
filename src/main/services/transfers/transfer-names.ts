import type { Entry, SpaceSemantics } from '@shared/storage';

/** Allocates non-colliding sibling names according to target SpaceSemantics. */
export function allocateTransferNames(
  entries: readonly Pick<Entry, 'name' | 'kind'>[],
  semantics?: SpaceSemantics,
): string[] {
  if (semantics?.allowsDuplicateNames) {
    return entries.map((entry) => entry.name);
  }
  const caseInsensitive = semantics?.caseSensitive === false;
  const nameKey = (name: string) => (caseInsensitive ? name.toLowerCase() : name);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = nameKey(entry.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const reserved = new Set(counts.keys());
  const nextNumbers = new Map<string, number>();
  return entries.map((entry) => {
    const key = nameKey(entry.name);
    if (counts.get(key) === 1) return entry.name;
    const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1;
    const hasExt = dot > 0;
    const stem = hasExt ? entry.name.slice(0, dot) : entry.name;
    const extension = hasExt ? entry.name.slice(dot) : '';
    let number = nextNumbers.get(key) ?? 1;
    let name: string;
    do {
      name = `${stem} (${number++})${extension}`;
    } while (reserved.has(nameKey(name)));
    nextNumbers.set(key, number);
    reserved.add(nameKey(name));
    return name;
  });
}

export function normalizeTargetName(name: string, semantics?: SpaceSemantics): string {
  return semantics?.caseSensitive === false ? name.toLowerCase() : name;
}
