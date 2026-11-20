import { dirname, parse, sep } from 'node:path';

export function uploadPathKey(path: string): string {
  return sep === '\\' ? path.toLowerCase() : path;
}

export function uploadPathsOverlap(left: string, right: string): boolean {
  const leftKey = uploadPathKey(left);
  const rightKey = uploadPathKey(right);
  return (
    leftKey === rightKey || leftKey.startsWith(rightKey + sep) || rightKey.startsWith(leftKey + sep)
  );
}

/** Allocate against every original sibling name before assigning numbered names. */
export function allocateUploadNames(
  entries: readonly { name: string; kind: 'file' | 'directory' }[],
): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = uploadPathKey(entry.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const reserved = new Set(counts.keys());
  const nextNumbers = new Map<string, number>();
  return entries.map((entry) => {
    const key = uploadPathKey(entry.name);
    if (counts.get(key) === 1) return entry.name;
    const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1;
    const hasExt = dot > 0;
    const stem = hasExt ? entry.name.slice(0, dot) : entry.name;
    const extension = hasExt ? entry.name.slice(dot) : '';
    let number = nextNumbers.get(key) ?? 1;
    let name: string;
    do {
      name = `${stem} (${number++})${extension}`;
    } while (reserved.has(uploadPathKey(name)));
    nextNumbers.set(key, number);
    reserved.add(uploadPathKey(name));
    return name;
  });
}

export function commonLocalParent(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const parents = paths.map((path) => dirname(path));
  const first = parents[0]!;
  if (parents.every((parent) => uploadPathKey(parent) === uploadPathKey(first))) {
    return first;
  }
  const root = parse(first).root;
  const split = (dir: string) =>
    dir
      .slice(parse(dir).root.length)
      .split(sep)
      .filter((segment) => segment.length > 0);
  const firstParts = split(first);
  let commonLength = firstParts.length;
  for (const parent of parents.slice(1)) {
    if (uploadPathKey(parse(parent).root) !== uploadPathKey(root)) {
      return first;
    }
    const parts = split(parent);
    commonLength = Math.min(commonLength, parts.length);
    for (let index = 0; index < commonLength; index++) {
      if (uploadPathKey(parts[index]!) !== uploadPathKey(firstParts[index]!)) {
        commonLength = index;
        break;
      }
    }
  }
  return commonLength === 0
    ? root || first
    : `${root}${firstParts.slice(0, commonLength).join(sep)}`;
}
