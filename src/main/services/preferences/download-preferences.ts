import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StorageError } from '@main/storage/core/errors';
import type { DownloadErrorCode, DownloadSettings } from '@shared/downloads';

export class DownloadPreferenceError extends Error {
  constructor(readonly code: DownloadErrorCode | 'PersistenceFailed') {
    super(code);
  }
}

export async function validateDownloadDirectory(input: string): Promise<string> {
  if (!input || input.includes('\0') || !isAbsolute(input)) {
    throw new DownloadPreferenceError('InvalidDownloadDirectory');
  }
  try {
    const path = await realpath(input);
    if (!(await lstat(path)).isDirectory()) {
      throw new DownloadPreferenceError('InvalidDownloadDirectory');
    }
    await access(path, constants.W_OK);
    return path;
  } catch (error) {
    if (error instanceof DownloadPreferenceError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL') {
      throw new DownloadPreferenceError('InvalidDownloadDirectory');
    }
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new StorageError('PermissionDenied', { cause: error });
    }
    throw new StorageError('OutcomeUnknown', { cause: error });
  }
}

export class DownloadPreferences {
  private revision = 0;

  constructor(
    private readonly systemDirectory: string,
    private readonly store: { read(): unknown; write(directory: string): void },
    private readonly validate: (input: string) => Promise<string> = validateDownloadDirectory,
  ) {}

  get(): DownloadSettings {
    const saved = this.store.read();
    if (saved !== undefined && saved !== null && typeof saved !== 'string') {
      throw new DownloadPreferenceError('PersistenceFailed');
    }
    return {
      directory: typeof saved === 'string' ? saved : this.systemDirectory,
    };
  }

  async set(directory: string): Promise<DownloadSettings> {
    const revision = ++this.revision;
    const value = await this.validate(directory);
    if (revision !== this.revision) return this.get();
    try {
      this.store.write(value);
    } catch {
      throw new DownloadPreferenceError('PersistenceFailed');
    }
    return this.get();
  }
}
