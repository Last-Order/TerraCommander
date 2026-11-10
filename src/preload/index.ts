import { contextBridge, ipcRenderer } from 'electron';
import { channels, type DesktopApi } from '../shared/contracts';

const api: DesktopApi = {
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
    measureDirectorySize: (id, folders) =>
      ipcRenderer.invoke(channels.measureDirectorySize, id, folders),
    cancelDirectoryMeasurement: (id) => ipcRenderer.invoke(channels.cancelDirectoryMeasurement, id),
  },
};

contextBridge.exposeInMainWorld('desktop', api);
