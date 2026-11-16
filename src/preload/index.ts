import { contextBridge, ipcRenderer } from 'electron';
import { channels, type DesktopApi } from '../shared/contracts';

const api: DesktopApi = {
  downloads: {
    getSettings: () => ipcRenderer.invoke(channels.getDownloadSettings),
    setDirectory: (path) => ipcRenderer.invoke(channels.setDownloadDirectory, path),
    chooseDirectory: (path) => ipcRenderer.invoke(channels.chooseDownloadDirectory, path),
    prepare: (request) => ipcRenderer.invoke(channels.prepareDownload, request),
    run: (id, attempt) => ipcRenderer.invoke(channels.runDownload, id, attempt),
    pause: (id) => ipcRenderer.invoke(channels.pauseDownload, id),
    cancel: (id) => ipcRenderer.invoke(channels.cancelDownload, id),
    onProgress: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: Parameters<typeof listener>[0],
      ) => listener(progress);
      ipcRenderer.on(channels.downloadProgress, handler);
      return () => {
        ipcRenderer.removeListener(channels.downloadProgress, handler);
      };
    },
  },
  getAppInfo: () => ipcRenderer.invoke(channels.getAppInfo),
  language: {
    get: () => ipcRenderer.invoke(channels.getLanguage),
    set: (preference) => ipcRenderer.invoke(channels.setLanguage, preference),
  },
  storage: {
    listConnections: () => ipcRenderer.invoke(channels.listConnections),
    listSpaces: (id, refresh) => ipcRenderer.invoke(channels.listSpaces, id, refresh),
    saveSpaces: (id, spaces) => ipcRenderer.invoke(channels.saveSpaces, id, spaces),
    chooseFolder: () => ipcRenderer.invoke(channels.chooseFolder),
    addGoogleDrive: () => ipcRenderer.invoke(channels.addGoogleDrive),
    reauthorize: (id) => ipcRenderer.invoke(channels.reauthorize, id),
    cancelAuthorization: () => ipcRenderer.invoke(channels.cancelAuthorization),
    listDirectory: (parent, cursor) => ipcRenderer.invoke(channels.listDirectory, parent, cursor),
    renameEntry: (ref, name) => ipcRenderer.invoke(channels.renameEntry, ref, name),
    deleteEntry: (ref) => ipcRenderer.invoke(channels.deleteEntry, ref),
    measureDirectorySize: (id, folders) =>
      ipcRenderer.invoke(channels.measureDirectorySize, id, folders),
    cancelDirectoryMeasurement: (id) => ipcRenderer.invoke(channels.cancelDirectoryMeasurement, id),
  },
};

contextBridge.exposeInMainWorld('desktop', api);
