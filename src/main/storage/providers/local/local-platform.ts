import { posix } from 'node:path';

export interface LocalPlatform {
  readonly isWindows: boolean;
  isValidEntryName(name: string): boolean;
  isValidLocatorSegment(segment: string): boolean;
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
  return {
    isWindows,
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
