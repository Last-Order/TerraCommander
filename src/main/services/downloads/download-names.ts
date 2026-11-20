import { extname, sep } from 'node:path';
import type { Entry } from '@shared/storage';

export function downloadPathKey(path: string): string {
  return sep === '\\' ? path.toLowerCase() : path;
}

export function downloadPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
}

/** Allocate against every original sibling name before assigning numbered names. */
export function allocateDownloadNames(entries: readonly Entry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = downloadPathKey(entry.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const reserved = new Set(counts.keys());
  const nextNumbers = new Map<string, number>();
  return entries.map((entry) => {
    const key = downloadPathKey(entry.name);
    if (counts.get(key) === 1) return entry.name;
    const extension = entry.kind === 'file' ? extname(entry.name) : '';
    const stem = extension ? entry.name.slice(0, -extension.length) : entry.name;
    let number = nextNumbers.get(key) ?? 1;
    let name: string;
    do {
      name = `${stem} (${number++})${extension}`;
    } while (reserved.has(downloadPathKey(name)));
    nextNumbers.set(key, number);
    reserved.add(downloadPathKey(name));
    return name;
  });
}
