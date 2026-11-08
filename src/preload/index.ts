import { contextBridge, ipcRenderer } from 'electron';
import { channels, type DesktopApi } from '../shared/contracts';

const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(channels.getAppInfo),
  storage: {
    listConnections: () => ipcRenderer.invoke(channels.listConnections),
    listSpaces: (id) => ipcRenderer.invoke(channels.listSpaces, id),
    saveSpaces: (id, spaces) => ipcRenderer.invoke(channels.saveSpaces, id, spaces),
    chooseFolder: () => ipcRenderer.invoke(channels.chooseFolder),
    addGoogleDrive: () => ipcRenderer.invoke(channels.addGoogleDrive),
    reauthorize: (id) => ipcRenderer.invoke(channels.reauthorize, id),
    cancelAuthorization: () => ipcRenderer.invoke(channels.cancelAuthorization),
    listDirectory: (parent, cursor) => ipcRenderer.invoke(channels.listDirectory, parent, cursor),
  },
};

contextBridge.exposeInMainWorld('desktop', api);
