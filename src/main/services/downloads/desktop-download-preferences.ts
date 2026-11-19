import { app } from 'electron';
import Store from 'electron-store';
import { DownloadPreferences } from './download-preferences';

export function createDesktopDownloadPreferences() {
  const store = new Store<{ directory: string }>({
    cwd: app.getPath('userData'),
    name: 'downloads',
    clearInvalidConfig: false,
  });
  return new DownloadPreferences(app.getPath('downloads'), {
    read: () => store.get('directory'),
    write: (directory) => store.set('directory', directory),
  });
}
