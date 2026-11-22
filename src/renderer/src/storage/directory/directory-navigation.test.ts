import { describe, expect, it } from 'vitest';
import { resolveDirectoryNavigationIndex } from './directory-navigation';

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
