import { describe, expect, it } from 'vitest';
import {
  clampColumnWidth,
  DEFAULT_DIRECTORY_COLUMN_WIDTHS,
  DIRECTORY_COLUMN_LIMITS,
  DIRECTORY_COLUMN_WIDTHS_STORAGE_KEY,
  DIRECTORY_NAME_MIN_WIDTH,
  loadDirectoryColumnWidths,
  resizeDirectoryColumns,
  saveDirectoryColumnWidths,
} from './directory-columns';

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('directory-columns', () => {
  it('rounds fractional widths and falls back to defaults for non-finite widths', () => {
    expect(clampColumnWidth('modifiedAt', 210.6)).toBe(211);
    expect(clampColumnWidth('modifiedAt', Number.NaN)).toBe(
      DIRECTORY_COLUMN_LIMITS.modifiedAt.defaultWidth,
    );

    expect(clampColumnWidth('size', Number.POSITIVE_INFINITY)).toBe(
      DIRECTORY_COLUMN_LIMITS.size.defaultWidth,
    );
  });

  it('resizes the modifiedAt column within its min/max and protects the name column min width', () => {
    const start = DEFAULT_DIRECTORY_COLUMN_WIDTHS;

    expect(resizeDirectoryColumns(start, 'modifiedAt', -50, 1000)).toEqual({
      modifiedAt: 258,
      size: 112,
    });
    expect(resizeDirectoryColumns(start, 'modifiedAt', 50, 1000)).toEqual({
      modifiedAt: 158,
      size: 112,
    });

    // Clamped at max and min
    expect(resizeDirectoryColumns(start, 'modifiedAt', -500, 1000)).toEqual({
      modifiedAt: DIRECTORY_COLUMN_LIMITS.modifiedAt.maxWidth,
      size: 112,
    });
    expect(resizeDirectoryColumns(start, 'modifiedAt', 500, 1000)).toEqual({
      modifiedAt: DIRECTORY_COLUMN_LIMITS.modifiedAt.minWidth,
      size: 112,
    });

    // Narrow table: cannot shrink name column below DIRECTORY_NAME_MIN_WIDTH
    const narrowTableWidth = DIRECTORY_NAME_MIN_WIDTH + 20 + start.modifiedAt + start.size;
    expect(resizeDirectoryColumns(start, 'modifiedAt', -100, narrowTableWidth)).toEqual({
      modifiedAt: start.modifiedAt + 20,
      size: start.size,
    });
  });

  it('resizes the size column while adjusting modifiedAt and overflowing into name when needed', () => {
    const start = DEFAULT_DIRECTORY_COLUMN_WIDTHS;

    // Drag left: widens size, narrows modifiedAt, keeps name fixed
    expect(resizeDirectoryColumns(start, 'size', -40, 1000)).toEqual({
      modifiedAt: 168,
      size: 152,
    });

    // Drag right: narrows size down to minWidth, widens modifiedAt
    expect(resizeDirectoryColumns(start, 'size', 100, 1000)).toEqual({
      modifiedAt: 240,
      size: DIRECTORY_COLUMN_LIMITS.size.minWidth,
    });

    // Drag left past modifiedAt minWidth: modifiedAt clamps at min, size continues to grow up to max
    expect(resizeDirectoryColumns(start, 'size', -200, 1000)).toEqual({
      modifiedAt: DIRECTORY_COLUMN_LIMITS.modifiedAt.minWidth,
      size: DIRECTORY_COLUMN_LIMITS.size.maxWidth,
    });

    // Narrow table: size cannot grow past remaining room above name + modifiedAt minimums
    const narrowStart = {
      modifiedAt: DIRECTORY_COLUMN_LIMITS.modifiedAt.minWidth + 30,
      size: start.size,
    };
    const narrowTableWidth = DIRECTORY_NAME_MIN_WIDTH + narrowStart.modifiedAt + narrowStart.size;
    expect(resizeDirectoryColumns(narrowStart, 'size', -200, narrowTableWidth)).toEqual({
      modifiedAt: DIRECTORY_COLUMN_LIMITS.modifiedAt.minWidth,
      size: narrowStart.size + 30,
    });
  });

  it('persists, clamps, and safely parses stored column widths', () => {
    const storage = createMemoryStorage();
    expect(loadDirectoryColumnWidths(storage)).toEqual(DEFAULT_DIRECTORY_COLUMN_WIDTHS);

    saveDirectoryColumnWidths({ modifiedAt: 260, size: 140 }, storage);
    expect(loadDirectoryColumnWidths(storage)).toEqual({ modifiedAt: 260, size: 140 });

    // Out-of-range stored values are clamped
    storage.setItem(DIRECTORY_COLUMN_WIDTHS_STORAGE_KEY, '{"modifiedAt":999,"size":10}');
    expect(loadDirectoryColumnWidths(storage)).toEqual({
      modifiedAt: DIRECTORY_COLUMN_LIMITS.modifiedAt.maxWidth,
      size: DIRECTORY_COLUMN_LIMITS.size.minWidth,
    });

    // Partial stored values fall back per-column
    storage.setItem(DIRECTORY_COLUMN_WIDTHS_STORAGE_KEY, '{"modifiedAt":250}');
    expect(loadDirectoryColumnWidths(storage)).toEqual({
      modifiedAt: 250,
      size: DIRECTORY_COLUMN_LIMITS.size.defaultWidth,
    });

    // Malformed values fall back to defaults
    for (const invalid of ['', 'not-json', 'null', '123']) {
      storage.setItem(DIRECTORY_COLUMN_WIDTHS_STORAGE_KEY, invalid);
      expect(loadDirectoryColumnWidths(storage)).toEqual(DEFAULT_DIRECTORY_COLUMN_WIDTHS);
    }
  });
});
