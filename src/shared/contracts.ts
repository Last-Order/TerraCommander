export const channels = {
  getAppInfo: 'app:get-info',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  versions: { electron: string; chromium: string; node: string };
}

export interface DesktopApi {
  getAppInfo: () => Promise<AppInfo>;
}
