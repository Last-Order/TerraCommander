import { describe, expect, it } from 'vitest';
import {
  isDirectoryNavigationKey,
  resolveDirectoryNavigationIndex,
  resolveSpaceSelectionModifiers,
} from './directory-navigation';

describe('directory-navigation', () => {
  it('recognizes directory navigation keys', () => {
    expect(isDirectoryNavigationKey('ArrowDown')).toBe(true);
    expect(isDirectoryNavigationKey('ArrowUp')).toBe(true);
    expect(isDirectoryNavigationKey('Home')).toBe(true);
    expect(isDirectoryNavigationKey('End')).toBe(true);
    expect(isDirectoryNavigationKey('PageDown')).toBe(true);
    expect(isDirectoryNavigationKey('PageUp')).toBe(true);
    expect(isDirectoryNavigationKey('Enter')).toBe(false);
    expect(isDirectoryNavigationKey('ArrowLeft')).toBe(false);
  });

  it('returns -1 for empty lists', () => {
    expect(resolveDirectoryNavigationIndex(0, -1, 'ArrowDown', 10)).toBe(-1);
    expect(resolveDirectoryNavigationIndex(0, 0, 'Home', 10)).toBe(-1);
  });

  it('resolves initial index when no row is active', () => {
    expect(resolveDirectoryNavigationIndex(5, -1, 'ArrowDown', 3)).toBe(0);
    expect(resolveDirectoryNavigationIndex(5, -1, 'PageDown', 3)).toBe(0);
    expect(resolveDirectoryNavigationIndex(5, -1, 'Home', 3)).toBe(0);
    expect(resolveDirectoryNavigationIndex(5, -1, 'ArrowUp', 3)).toBe(4);
    expect(resolveDirectoryNavigationIndex(5, -1, 'PageUp', 3)).toBe(4);
    expect(resolveDirectoryNavigationIndex(5, -1, 'End', 3)).toBe(4);
  });

  it('moves and clamps within bounds', () => {
    expect(resolveDirectoryNavigationIndex(5, 0, 'ArrowUp', 3)).toBe(0);
    expect(resolveDirectoryNavigationIndex(5, 0, 'ArrowDown', 3)).toBe(1);
    expect(resolveDirectoryNavigationIndex(5, 4, 'ArrowDown', 3)).toBe(4);
    expect(resolveDirectoryNavigationIndex(5, 4, 'ArrowUp', 3)).toBe(3);
    expect(resolveDirectoryNavigationIndex(10, 2, 'PageDown', 4)).toBe(6);
    expect(resolveDirectoryNavigationIndex(10, 8, 'PageDown', 4)).toBe(9);
    expect(resolveDirectoryNavigationIndex(10, 5, 'PageUp', 4)).toBe(1);
    expect(resolveDirectoryNavigationIndex(10, 2, 'PageUp', 4)).toBe(0);
    expect(resolveDirectoryNavigationIndex(10, 5, 'Home', 4)).toBe(0);
    expect(resolveDirectoryNavigationIndex(10, 5, 'End', 4)).toBe(9);
  });

  it('handles invalid page steps safely', () => {
    expect(resolveDirectoryNavigationIndex(5, 1, 'PageDown', 0)).toBe(2);
    expect(resolveDirectoryNavigationIndex(5, 3, 'PageUp', -5)).toBe(2);
  });

  it('maps space selection modifiers', () => {
    expect(resolveSpaceSelectionModifiers({ ctrlKey: false, shiftKey: false })).toEqual({
      toggle: false,
      range: false,
    });
    expect(resolveSpaceSelectionModifiers({ ctrlKey: true, shiftKey: false })).toEqual({
      toggle: true,
      range: false,
    });
    expect(resolveSpaceSelectionModifiers({ ctrlKey: false, shiftKey: true })).toEqual({
      toggle: false,
      range: true,
    });
  });
});
