import type { StorageBrowserApi } from './storage-browser';

export const channels = {
  getAppInfo: 'app:get-info',
  listConnections: 'storage:list-connections',
  listSpaces: 'storage:list-spaces',
  saveSpaces: 'storage:save-spaces',
  chooseFolder: 'storage:choose-folder',
  addGoogleDrive: 'storage:add-google-drive',
  reauthorize: 'storage:reauthorize',
  cancelAuthorization: 'storage:cancel-authorization',
  listDirectory: 'storage:list-directory',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  versions: { electron: string; chromium: string; node: string };
}

export interface DesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  storage: StorageBrowserApi;
}
