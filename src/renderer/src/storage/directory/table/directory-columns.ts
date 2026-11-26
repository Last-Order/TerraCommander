import { create } from 'zustand';

export const DIRECTORY_COLUMN_WIDTHS_STORAGE_KEY = 'terra-commander:directory-column-widths';

export const DIRECTORY_NAME_MIN_WIDTH = 140;

export const DIRECTORY_COLUMN_LIMITS = {
  modifiedAt: { defaultWidth: 208, minWidth: 120, maxWidth: 360 },
  size: { defaultWidth: 112, minWidth: 80, maxWidth: 240 },
} as const;

export type ResizableDirectoryColumn = keyof typeof DIRECTORY_COLUMN_LIMITS;

export interface DirectoryColumnWidths {
  modifiedAt: number;
  size: number;
}

export const DEFAULT_DIRECTORY_COLUMN_WIDTHS: DirectoryColumnWidths = {
  modifiedAt: DIRECTORY_COLUMN_LIMITS.modifiedAt.defaultWidth,
  size: DIRECTORY_COLUMN_LIMITS.size.defaultWidth,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampColumnWidth(column: ResizableDirectoryColumn, width: number): number {
  const { defaultWidth, minWidth, maxWidth } = DIRECTORY_COLUMN_LIMITS[column];
  if (!Number.isFinite(width)) return defaultWidth;
  return clamp(Math.round(width), minWidth, maxWidth);
}

export function clampDirectoryColumnWidths(widths: DirectoryColumnWidths): DirectoryColumnWidths {
  return {
    modifiedAt: clampColumnWidth('modifiedAt', widths.modifiedAt),
    size: clampColumnWidth('size', widths.size),
  };
}

export function resizeDirectoryColumns(
  start: DirectoryColumnWidths,
  column: ResizableDirectoryColumn,
  deltaX: number,
  tableWidth: number,
): DirectoryColumnWidths {
  const startWidths = clampDirectoryColumnWidths(start);
  if (!Number.isFinite(deltaX) || deltaX === 0) return startWidths;

  const safeTableWidth = Number.isFinite(tableWidth)
    ? tableWidth
    : DIRECTORY_NAME_MIN_WIDTH + startWidths.modifiedAt + startWidths.size;
  const startNameWidth = Math.max(0, safeTableWidth - startWidths.modifiedAt - startWidths.size);

  if (column === 'modifiedAt') {
    const { minWidth, maxWidth } = DIRECTORY_COLUMN_LIMITS.modifiedAt;
    const minDelta = Math.max(
      startWidths.modifiedAt - maxWidth,
      Math.min(0, DIRECTORY_NAME_MIN_WIDTH - startNameWidth),
    );
    const maxDelta = startWidths.modifiedAt - minWidth;
    const clampedDelta = clamp(deltaX, minDelta, maxDelta);
    return {
      modifiedAt: clampColumnWidth('modifiedAt', startWidths.modifiedAt - clampedDelta),
      size: startWidths.size,
    };
  }

  const dateLimits = DIRECTORY_COLUMN_LIMITS.modifiedAt;
  const sizeLimits = DIRECTORY_COLUMN_LIMITS.size;
  const maxShrinkLeft = Math.max(
    0,
    startNameWidth + startWidths.modifiedAt - (DIRECTORY_NAME_MIN_WIDTH + dateLimits.minWidth),
  );
  const maxAllowedSize = Math.min(sizeLimits.maxWidth, startWidths.size + maxShrinkLeft);
  const nextSize = clamp(
    Math.round(startWidths.size - deltaX),
    sizeLimits.minWidth,
    maxAllowedSize,
  );
  const effectiveDelta = startWidths.size - nextSize;
  const nextModifiedAt = clampColumnWidth('modifiedAt', startWidths.modifiedAt + effectiveDelta);
  return {
    modifiedAt: nextModifiedAt,
    size: nextSize,
  };
}

export function parseDirectoryColumnWidths(raw: string | null): DirectoryColumnWidths {
  if (!raw) return DEFAULT_DIRECTORY_COLUMN_WIDTHS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_DIRECTORY_COLUMN_WIDTHS;
    const { modifiedAt, size } = parsed as Record<string, unknown>;
    return {
      modifiedAt:
        typeof modifiedAt === 'number'
          ? clampColumnWidth('modifiedAt', modifiedAt)
          : DIRECTORY_COLUMN_LIMITS.modifiedAt.defaultWidth,
      size:
        typeof size === 'number'
          ? clampColumnWidth('size', size)
          : DIRECTORY_COLUMN_LIMITS.size.defaultWidth,
    };
  } catch {
    return DEFAULT_DIRECTORY_COLUMN_WIDTHS;
  }
}

function getDefaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadDirectoryColumnWidths(
  storage: Pick<Storage, 'getItem'> | null = getDefaultStorage(),
): DirectoryColumnWidths {
  if (!storage) return DEFAULT_DIRECTORY_COLUMN_WIDTHS;
  try {
    return parseDirectoryColumnWidths(storage.getItem(DIRECTORY_COLUMN_WIDTHS_STORAGE_KEY));
  } catch {
    return DEFAULT_DIRECTORY_COLUMN_WIDTHS;
  }
}

export function saveDirectoryColumnWidths(
  widths: DirectoryColumnWidths,
  storage: Pick<Storage, 'setItem'> | null = getDefaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      DIRECTORY_COLUMN_WIDTHS_STORAGE_KEY,
      JSON.stringify(clampDirectoryColumnWidths(widths)),
    );
  } catch {
    // Ignore storage write failures (e.g. quota exceeded or restricted storage).
  }
}

interface DirectoryColumnWidthsState {
  widths: DirectoryColumnWidths;
  setWidths: (widths: DirectoryColumnWidths) => void;
  resetColumnWidth: (column: ResizableDirectoryColumn) => void;
}

export const useDirectoryColumnWidthsStore = create<DirectoryColumnWidthsState>((set) => ({
  widths: loadDirectoryColumnWidths(),
  setWidths: (widths) =>
    set((state) => {
      const next = clampDirectoryColumnWidths(widths);
      if (next.modifiedAt === state.widths.modifiedAt && next.size === state.widths.size) {
        return state;
      }
      return { widths: next };
    }),
  resetColumnWidth: (column) =>
    set((state) => {
      const next: DirectoryColumnWidths = {
        ...state.widths,
        [column]: DIRECTORY_COLUMN_LIMITS[column].defaultWidth,
      };
      saveDirectoryColumnWidths(next);
      return { widths: next };
    }),
}));
