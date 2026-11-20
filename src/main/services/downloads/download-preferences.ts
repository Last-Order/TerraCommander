import type { DownloadSettings } from '@shared/downloads';
import { DownloadError, downloadDirectory } from './download-paths';

export class DownloadPreferences {
  private revision = 0;
  constructor(
    private readonly systemDirectory: string,
    private readonly store: { read(): unknown; write(directory: string): void },
  ) {}

  get(): DownloadSettings {
    const saved = this.store.read();
    if (saved !== undefined && saved !== null && typeof saved !== 'string')
      throw new DownloadError('PersistenceFailed');
    return {
      directory: typeof saved === 'string' ? saved : this.systemDirectory,
    };
  }

  async set(directory: string): Promise<DownloadSettings> {
    const revision = ++this.revision;
    const value = await downloadDirectory(directory);
    if (revision !== this.revision) return this.get();
    try {
      this.store.write(value);
    } catch {
      throw new DownloadError('PersistenceFailed');
    }
    return this.get();
  }
}
