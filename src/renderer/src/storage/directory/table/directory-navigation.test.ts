import { describe, expect, it } from 'vitest';
import {
  resolveDirectoryNavigationIndex,
  resolveDirectoryPageStep,
  resolveDirectoryScrollPadding,
} from './directory-navigation';

describe('resolveDirectoryNavigationIndex', () => {
  it('returns -1 for empty lists and enters from the expected edge when no row is active', () => {
    expect(resolveDirectoryNavigationIndex(0, -1, 'ArrowDown', 10)).toBe(-1);
    expect(resolveDirectoryNavigationIndex(5, -1, 'ArrowDown', 3)).toBe(0);
    expect(resolveDirectoryNavigationIndex(5, -1, 'PageDown', 3)).toBe(0);
    expect(resolveDirectoryNavigationIndex(5, -1, 'ArrowUp', 3)).toBe(4);
    expect(resolveDirectoryNavigationIndex(5, -1, 'PageUp', 3)).toBe(4);
  });

  it('moves, clamps within bounds, and falls back to a step of 1 for invalid page sizes', () => {
    expect(resolveDirectoryNavigationIndex(5, 0, 'ArrowUp', 3)).toBe(0);
    expect(resolveDirectoryNavigationIndex(5, 0, 'ArrowDown', 3)).toBe(1);
    expect(resolveDirectoryNavigationIndex(5, 4, 'ArrowDown', 3)).toBe(4);
    expect(resolveDirectoryNavigationIndex(10, 2, 'PageDown', 4)).toBe(6);
    expect(resolveDirectoryNavigationIndex(10, 8, 'PageDown', 4)).toBe(9);
    expect(resolveDirectoryNavigationIndex(10, 2, 'PageUp', 4)).toBe(0);
    expect(resolveDirectoryNavigationIndex(10, 5, 'Home', 4)).toBe(0);
    expect(resolveDirectoryNavigationIndex(10, 5, 'End', 4)).toBe(9);
    expect(resolveDirectoryNavigationIndex(5, 1, 'PageDown', 0)).toBe(2);
    expect(resolveDirectoryNavigationIndex(5, 3, 'PageUp', -5)).toBe(2);
  });
});

describe('resolveDirectoryScrollPadding', () => {
  it('respects sticky header and bottom scroll padding when space allows', () => {
    expect(
      resolveDirectoryScrollPadding({
        viewportHeight: 500,
        headerHeight: 37,
        scrollPaddingStart: 40,
        scrollPaddingEnd: 216,
        rowHeight: 36,
      }),
    ).toEqual({ start: 40, end: 216 });

    expect(
      resolveDirectoryScrollPadding({
        viewportHeight: 500,
        headerHeight: 48,
        scrollPaddingStart: 40,
        scrollPaddingEnd: 16,
        rowHeight: 36,
      }),
    ).toEqual({ start: 48, end: 16 });
  });

  it('clamps padding so at least one row remains in the unpadded viewport', () => {
    expect(
      resolveDirectoryScrollPadding({
        viewportHeight: 250,
        headerHeight: 37,
        scrollPaddingStart: 40,
        scrollPaddingEnd: 216,
        rowHeight: 36,
      }),
    ).toEqual({ start: 40, end: 174 });

    expect(
      resolveDirectoryScrollPadding({
        viewportHeight: 0,
        headerHeight: 37,
        scrollPaddingStart: 40,
        scrollPaddingEnd: 16,
        rowHeight: 36,
      }),
    ).toEqual({ start: 0, end: 0 });
  });
});

describe('resolveDirectoryPageStep', () => {
  it('computes visible rows excluding top and bottom scroll padding', () => {
    expect(resolveDirectoryPageStep(500, { start: 40, end: 16 }, 36)).toBe(12);
    expect(resolveDirectoryPageStep(500, { start: 40, end: 216 }, 36)).toBe(6);
    expect(resolveDirectoryPageStep(250, { start: 40, end: 174 }, 36)).toBe(1);
    expect(resolveDirectoryPageStep(40, { start: 40, end: 0 }, 36)).toBe(1);
  });
});
