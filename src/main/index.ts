import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, session } from 'electron';
import log from 'electron-log/main';
import { registerIpcHandlers } from './ipc';
import { isTrustedRenderer } from './security';

let mainWindow: BrowserWindow | null = null;
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererFile = new URL('../renderer/index.html', import.meta.url);
const entryUrl = developmentUrl ?? rendererFile.href;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    title: 'TerraCommander',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRenderer(url, entryUrl)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process exited', details);
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  window.on('closed', () => {
    mainWindow = null;
  });

  const loading = developmentUrl
    ? window.loadURL(developmentUrl)
    : window.loadFile(fileURLToPath(rendererFile));
  void loading.catch((error: unknown) => {
    log.error('Could not load the renderer', error);
    dialog.showErrorBox('TerraCommander', '应用加载失败，请重新启动。');
    app.quit();
  });
}

void app
  .whenReady()
  .then(() => {
    app.setAppUserModelId('com.terracommander.app');
    app.setName('TerraCommander');
    log.info('Starting TerraCommander', { version: app.getVersion() });

    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    registerIpcHandlers(() => mainWindow, entryUrl);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error: unknown) => {
    log.error('Application startup failed', error);
    dialog.showErrorBox('TerraCommander', '应用启动失败，请查看应用日志。');
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
