import { posix, win32 } from 'node:path';

export interface LocalPlatform {
  readonly isWindows: boolean;
  readonly caseSensitive: boolean;
  isValidEntryName(name: string): boolean;
  isValidLocatorSegment(segment: string): boolean;
  isSubpath(parentPath: string, childPath: string): boolean;
  isSameOrSubpath(parentPath: string, childPath: string): boolean;
}

const windowsInvalidNameChars = /[<>:"\\|?*]/;
const windowsTrailingDotOrSpace = /[. ]$/;
const windowsReservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const windowsInvalidLocatorChars = /[\\/:]|[. ]$/;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 32) return true;
  }
  return false;
}

export function createLocalPlatform(platform: NodeJS.Platform = process.platform): LocalPlatform {
  const isWindows = platform === 'win32';
  const caseSensitive = platform !== 'win32' && platform !== 'darwin';
  const pathOps = isWindows ? win32 : posix;
  const relativePath = (parentPath: string, childPath: string): string => {
    const parent = caseSensitive ? parentPath : parentPath.toLowerCase();
    const child = caseSensitive ? childPath : childPath.toLowerCase();
    return pathOps.relative(parent, child);
  };
  return {
    isWindows,
    caseSensitive,
    isValidEntryName(name: string): boolean {
      if (
        !name.trim() ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\0')
      ) {
        return false;
      }
      if (!isWindows) return true;
      return !(
        windowsInvalidNameChars.test(name) ||
        windowsTrailingDotOrSpace.test(name) ||
        hasControlCharacter(name) ||
        windowsReservedName.test(name)
      );
    },
    isValidLocatorSegment(segment: string): boolean {
      if (
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\0')
      ) {
        return false;
      }
      if (!isWindows) return true;
      return !windowsInvalidLocatorChars.test(segment);
    },
    isSubpath(parentPath: string, childPath: string): boolean {
      const rel = relativePath(parentPath, childPath);
      return (
        rel !== '' &&
        rel !== '..' &&
        !rel.startsWith(`..${pathOps.sep}`) &&
        !pathOps.isAbsolute(rel)
      );
    },
    isSameOrSubpath(parentPath: string, childPath: string): boolean {
      const rel = relativePath(parentPath, childPath);
      return (
        rel === '' ||
        (rel !== '..' && !rel.startsWith(`..${pathOps.sep}`) && !pathOps.isAbsolute(rel))
      );
    },
  };
}

export const defaultLocalPlatform = createLocalPlatform();

export function splitLocalLocator(locator: string): string[] {
  return locator === '.' ? [] : locator.split('/');
}

export function joinLocalLocator(parent: string, name: string): string {
  return posix.join(parent, name);
}

export function parentLocalLocator(locator: string): string {
  return posix.dirname(locator);
}
