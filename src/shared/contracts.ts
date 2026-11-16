import type { LanguagePreference, LanguageSettings } from './language';
import type { StorageBrowserApi } from './storage-browser';
import type { DownloadsApi } from './downloads';

export const channels = {
  getAppInfo: 'app:get-info',
  getLanguage: 'app:get-language',
  setLanguage: 'app:set-language',
  listConnections: 'storage:list-connections',
  listSpaces: 'storage:list-spaces',
  saveSpaces: 'storage:save-spaces',
  chooseFolder: 'storage:choose-folder',
  addGoogleDrive: 'storage:add-google-drive',
  reauthorize: 'storage:reauthorize',
  cancelAuthorization: 'storage:cancel-authorization',
  listDirectory: 'storage:list-directory',
  renameEntry: 'storage:rename-entry',
  deleteEntry: 'storage:delete-entry',
  measureDirectorySize: 'storage:measure-directory-size',
  cancelDirectoryMeasurement: 'storage:cancel-directory-measurement',
  getDownloadSettings: 'downloads:get-settings',
  setDownloadDirectory: 'downloads:set-directory',
  chooseDownloadDirectory: 'downloads:choose-directory',
  prepareDownload: 'downloads:prepare',
  runDownload: 'downloads:run',
  pauseDownload: 'downloads:pause',
  cancelDownload: 'downloads:cancel',
  downloadProgress: 'downloads:progress',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  versions: { electron: string; chromium: string; node: string };
}

export interface DesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  language: {
    get(): Promise<LanguageSettings>;
    set(preference: LanguagePreference): Promise<LanguageSettings | null>;
  };
  storage: StorageBrowserApi;
  downloads: DownloadsApi;
}
