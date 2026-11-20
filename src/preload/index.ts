import { contextBridge, ipcRenderer } from 'electron';
import { channels, type DesktopApi } from '@shared/contracts';

const api: DesktopApi = {
  settings: {
    get: (key) => ipcRenderer.invoke(channels.getSetting, key),
    set: (key, value) => ipcRenderer.invoke(channels.setSetting, key, value),
  },
  downloads: {
    chooseDirectory: (path) => ipcRenderer.invoke(channels.chooseDownloadDirectory, path),
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
    addConnection: (provider) => ipcRenderer.invoke(channels.addConnection, provider),
    reauthorize: (id) => ipcRenderer.invoke(channels.reauthorize, id),
    cancelAuthorization: () => ipcRenderer.invoke(channels.cancelAuthorization),
    listDirectory: (parent, cursor) => ipcRenderer.invoke(channels.listDirectory, parent, cursor),
    measureDirectorySize: (id, folders) =>
      ipcRenderer.invoke(channels.measureDirectorySize, id, folders),
    cancelDirectoryMeasurement: (id) => ipcRenderer.invoke(channels.cancelDirectoryMeasurement, id),
  },
  tasks: {
    getSnapshot: () => ipcRenderer.invoke(channels.getTaskSnapshot),
    enqueueRename: (request) => ipcRenderer.invoke(channels.enqueueRenameTask, request),
    enqueueDelete: (request) => ipcRenderer.invoke(channels.enqueueDeleteTask, request),
    uploadFile: (request) => ipcRenderer.invoke(channels.uploadFileTask, request),
    uploadFolder: (request) => ipcRenderer.invoke(channels.uploadFolderTask, request),
    prepareDownload: (request) => ipcRenderer.invoke(channels.prepareDownloadTask, request),
    confirmDownload: (confirmationId) =>
      ipcRenderer.invoke(channels.confirmDownloadTask, confirmationId),
    cancelDownloadConfirmation: (confirmationId) =>
      ipcRenderer.invoke(channels.cancelDownloadConfirmation, confirmationId),
    pause: (taskId) => ipcRenderer.invoke(channels.pauseTask, taskId),
    resume: (taskId) => ipcRenderer.invoke(channels.resumeTask, taskId),
    cancel: (taskId) => ipcRenderer.invoke(channels.cancelTask, taskId),
    retry: (taskId) => ipcRenderer.invoke(channels.retryTask, taskId),
    clearFinished: () => ipcRenderer.invoke(channels.clearFinishedTasks),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, event: Parameters<typeof listener>[0]) =>
        listener(event);
      ipcRenderer.on(channels.taskEvent, handler);
      return () => {
        ipcRenderer.removeListener(channels.taskEvent, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('desktop', api);
