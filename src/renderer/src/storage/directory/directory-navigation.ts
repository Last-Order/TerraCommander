export type DirectoryNavigationKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'Home'
  | 'End'
  | 'PageDown'
  | 'PageUp';

const navigationKeys = new Set<string>([
  'ArrowDown',
  'ArrowUp',
  'Home',
  'End',
  'PageDown',
  'PageUp',
]);

export function isDirectoryNavigationKey(key: string): key is DirectoryNavigationKey {
  return navigationKeys.has(key);
}

export function resolveDirectoryNavigationIndex(
  rowCount: number,
  currentIndex: number,
  key: DirectoryNavigationKey,
  pageStep: number,
): number {
  if (rowCount <= 0) return -1;
  const lastIndex = rowCount - 1;
  const step = Math.max(1, Math.floor(pageStep));
  const clampedCurrent = currentIndex >= 0 && currentIndex <= lastIndex ? currentIndex : -1;

  switch (key) {
    case 'ArrowDown':
      return clampedCurrent < 0 ? 0 : Math.min(lastIndex, clampedCurrent + 1);
    case 'ArrowUp':
      return clampedCurrent < 0 ? lastIndex : Math.max(0, clampedCurrent - 1);
    case 'Home':
      return 0;
    case 'End':
      return lastIndex;
    case 'PageDown':
      return clampedCurrent < 0 ? 0 : Math.min(lastIndex, clampedCurrent + step);
    case 'PageUp':
      return clampedCurrent < 0 ? lastIndex : Math.max(0, clampedCurrent - step);
  }
}
