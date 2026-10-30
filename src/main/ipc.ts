import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { channels, type AppInfo } from '../shared/contracts';
import { isTrustedRenderer } from './security';

export function registerIpcHandlers(getWindow: () => BrowserWindow | null, entryUrl: string): void {
  function assertTrusted(event: IpcMainInvokeEvent): void {
    const window = getWindow();
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedRenderer(event.senderFrame.url, entryUrl)
    ) {
      throw new Error('Untrusted IPC sender');
    }
  }

  ipcMain.handle(channels.getAppInfo, (event): AppInfo => {
    assertTrusted(event);
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      versions: {
        electron: process.versions.electron ?? 'unknown',
        chromium: process.versions.chrome ?? 'unknown',
        node: process.versions.node,
      },
    };
  });
}
