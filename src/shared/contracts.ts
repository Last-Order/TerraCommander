import type { DownloadsApi } from './downloads';
import type { LanguagePreference, LanguageSettings } from './language';
import type { SettingsApi } from './settings';
import type { BrowserResult, StorageBrowserApi } from './storage-browser';
import type { TasksApi } from './tasks';

export const channels = {
  getAppInfo: 'app:get-info',
  getLanguage: 'app:get-language',
  setLanguage: 'app:set-language',
  listConnections: 'storage:list-connections',
  listSpaces: 'storage:list-spaces',
  saveSpaces: 'storage:save-spaces',
  chooseFolder: 'storage:choose-folder',
  addConnection: 'storage:add-connection',
  reauthorize: 'storage:reauthorize',
  cancelAuthorization: 'storage:cancel-authorization',
  listDirectory: 'storage:list-directory',
  measureDirectorySize: 'storage:measure-directory-size',
  cancelDirectoryMeasurement: 'storage:cancel-directory-measurement',
  getSetting: 'settings:get',
  setSetting: 'settings:set',
  chooseDownloadDirectory: 'downloads:choose-directory',
  getTaskSnapshot: 'tasks:snapshot',
  enqueueRenameTask: 'tasks:enqueue-rename',
  enqueueDeleteTask: 'tasks:enqueue-delete',
  uploadFileTask: 'tasks:upload-file',
  uploadFolderTask: 'tasks:upload-folder',
  prepareDownloadTask: 'tasks:prepare-download',
  confirmDownloadTask: 'tasks:confirm-download',
  cancelDownloadConfirmation: 'tasks:cancel-download-confirmation',
  pauseTask: 'tasks:pause',
  resumeTask: 'tasks:resume',
  cancelTask: 'tasks:cancel',
  retryTask: 'tasks:retry',
  clearFinishedTasks: 'tasks:clear-finished',
  taskEvent: 'tasks:event',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  versions: { electron: string; chromium: string; node: string };
}

export interface DesktopApi {
  getAppInfo: () => Promise<BrowserResult<AppInfo>>;
  language: {
    get(): Promise<BrowserResult<LanguageSettings>>;
    set(preference: LanguagePreference): Promise<BrowserResult<LanguageSettings>>;
  };
  storage: StorageBrowserApi;
  settings: SettingsApi;
  downloads: DownloadsApi;
  tasks: TasksApi;
}
