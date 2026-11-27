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

export interface DirectoryScrollPadding {
  start: number;
  end: number;
}

export function resolveDirectoryScrollPadding({
  viewportHeight,
  headerHeight,
  scrollPaddingStart,
  scrollPaddingEnd,
  rowHeight,
}: {
  viewportHeight: number;
  headerHeight: number;
  scrollPaddingStart: number;
  scrollPaddingEnd: number;
  rowHeight: number;
}): DirectoryScrollPadding {
  const safeViewport = Math.max(0, viewportHeight);
  const safeRow = Math.max(1, rowHeight);
  const rawStart = Math.max(0, headerHeight, scrollPaddingStart);
  const rawEnd = Math.max(0, scrollPaddingEnd);
  const start = Math.min(rawStart, Math.max(0, safeViewport - safeRow));
  const end = Math.min(rawEnd, Math.max(0, safeViewport - start - safeRow));
  return { start, end };
}

export function resolveDirectoryPageStep(
  viewportHeight: number,
  scrollPadding: DirectoryScrollPadding,
  rowHeight: number,
): number {
  const safeRow = Math.max(1, rowHeight);
  const visibleHeight = Math.max(0, viewportHeight - scrollPadding.start - scrollPadding.end);
  return Math.max(1, Math.floor(visibleHeight / safeRow));
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

export function resolveDirectoryTabIndex(
  rowCount: number,
  currentIndex: number,
  reverse: boolean,
): number {
  if (rowCount <= 0) return -1;
  const lastIndex = rowCount - 1;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex > lastIndex) {
    return reverse ? lastIndex : 0;
  }
  return reverse ? (currentIndex - 1 + rowCount) % rowCount : (currentIndex + 1) % rowCount;
}
