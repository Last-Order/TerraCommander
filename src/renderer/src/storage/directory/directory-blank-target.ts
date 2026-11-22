const nonBlankDirectoryTargetSelector = 'tr[data-index], thead, [data-directory-search]';

export function isDirectoryBlankTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest(nonBlankDirectoryTargetSelector);
}
