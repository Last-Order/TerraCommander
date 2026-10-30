import { contextBridge, ipcRenderer } from 'electron';
import { channels, type DesktopApi } from '../shared/contracts';

const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(channels.getAppInfo),
};

contextBridge.exposeInMainWorld('desktop', api);
