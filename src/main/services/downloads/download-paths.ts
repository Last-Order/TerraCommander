import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { StorageError } from '@main/storage/core/errors';
import type { DownloadErrorCode } from '@shared/downloads';

export class DownloadError extends Error {
  constructor(readonly code: DownloadErrorCode | 'PersistenceFailed') {
    super(code);
  }
}

export function downloadFailure(error: unknown): never {
  if (error instanceof StorageError || error instanceof DownloadError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOSPC' || code === 'EDQUOT') throw new StorageError('InsufficientSpace');
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    throw new StorageError('PermissionDenied');
  if (code === 'EEXIST') throw new StorageError('AlreadyExists');
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new StorageError('NotFound');
  if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV')
    throw new StorageError('Unsupported');
  throw new StorageError('OutcomeUnknown', { cause: error });
}

export async function downloadDirectory(input: string): Promise<string> {
  if (!input || input.includes('\0') || !isAbsolute(input))
    throw new DownloadError('InvalidDownloadDirectory');
  try {
    const path = await realpath(input);
    if (!(await lstat(path)).isDirectory()) throw new DownloadError('InvalidDownloadDirectory');
    await access(path, constants.W_OK);
    return path;
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL')
      throw new DownloadError('InvalidDownloadDirectory');
    downloadFailure(error);
  }
}

export function validateDownloadName(name: string): void {
  if (
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    /[/\0]/.test(name) ||
    (sep === '\\' &&
      (/[<>:"\\|?*]|[. ]$/.test(name) ||
        Array.from(name).some((character) => character.charCodeAt(0) < 32) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))
  )
    throw new DownloadError('InvalidDownloadName');
}
