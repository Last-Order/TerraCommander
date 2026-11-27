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
  enqueueCreateDirectoryTask: 'tasks:enqueue-create-directory',
  enqueueRenameTask: 'tasks:enqueue-rename',
  enqueueDeleteTask: 'tasks:enqueue-delete',
  pasteEntriesTask: 'tasks:paste-entries',
  transferFromLocalDialogTask: 'tasks:transfer-from-local-dialog',
  transferFromLocalPathsTask: 'tasks:transfer-from-local-paths',
  transferToLocalDirectoryTask: 'tasks:transfer-to-local-directory',
  confirmTransferTask: 'tasks:confirm-transfer',
  cancelTransferConfirmation: 'tasks:cancel-transfer-confirmation',
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
