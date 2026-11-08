import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, session } from 'electron';
import log from 'electron-log/main';
import { fallbackLanguage, type AppLanguage } from '../shared/language';
import { setApplicationMenu } from './application-menu';
import { registerIpcHandlers } from './ipc';
import { nativeMessages } from './native-messages';
import { isTrustedRenderer } from './security';
import { ApplicationServices } from './services/application-services';
import {
  createLanguagePreferences,
  type LanguagePreferences,
} from './services/language-preferences';

let mainWindow: BrowserWindow | null = null;
let languagePreferences: LanguagePreferences | undefined;
const services = new ApplicationServices({ whenReady: () => app.whenReady(), getLanguage });
let shutdownStarted = false;
let shutdownComplete = false;
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererFile = new URL('../renderer/index.html', import.meta.url);
const entryUrl = developmentUrl ?? rendererFile.href;

// Account storage has one main-process writer. Development uses a separate profile
// so test OAuth clients cannot overwrite grants in an installed release.
const profileName = app.isPackaged ? 'TerraCommander' : 'TerraCommander Development';
app.setName('TerraCommander');
const profilePath = join(app.getPath('appData'), profileName);
mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();

function getLanguage(): AppLanguage {
  return languagePreferences?.get().language ?? fallbackLanguage;
}

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
});

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
    dialog.showErrorBox('TerraCommander', nativeMessages[getLanguage()].rendererFailed);
    app.quit();
  });
}

void app
  .whenReady()
  .then(() => {
    if (!ownsProfile) return;
    app.setAppUserModelId('com.terracommander.app');
    app.setName('TerraCommander');
    log.info('Starting TerraCommander', { version: app.getVersion() });

    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    const preferences = createLanguagePreferences(profilePath, () =>
      app.getPreferredSystemLanguages(),
    );
    languagePreferences = preferences;
    setApplicationMenu(getLanguage());
    registerIpcHandlers(() => mainWindow, entryUrl, services, {
      get: preferences.get,
      set(preference) {
        const previous = getLanguage();
        const settings = preferences.set(preference);
        if (settings && settings.language !== previous) setApplicationMenu(settings.language);
        return settings;
      },
    });
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error: unknown) => {
    // Keep diagnostics safe even when future startup dependencies carry private causes.
    log.error('Application startup failed', {
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    dialog.showErrorBox('TerraCommander', nativeMessages[getLanguage()].startupFailed);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void services
    .dispose()
    .catch(() => {
      log.error('Application services could not finish shutting down');
    })
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
