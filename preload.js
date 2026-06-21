const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('charon', {
  app: {
    info: () => ipcRenderer.invoke('app:info')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    autoDetectSteam: () => ipcRenderer.invoke('settings:autoDetectSteam'),
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder')
  },
  steam: {
    search: (query, options) => ipcRenderer.invoke('steam:search', query, options || {}),
    details: (appId, options) => ipcRenderer.invoke('steam:details', appId, options || {}),
    installed: (options) => ipcRenderer.invoke('steam:installed', options || {}),
    restart: () => ipcRenderer.invoke('steam:restart'),
    openClient: () => ipcRenderer.invoke('steam:openClient'),
    open: (payload) => ipcRenderer.invoke('steam:open', payload)
  },
  api: {
    activate: () => ipcRenderer.invoke('api:activate'),
    stats: () => ipcRenderer.invoke('api:stats'),
    requestGame: (payload) => ipcRenderer.invoke('api:requestGame', payload),
    generateInstall: (payload) => ipcRenderer.invoke('api:generateInstall', payload),
    installZipBytes: (payload) => ipcRenderer.invoke('api:installZipBytes', payload)
  },
  manifests: {
    list: () => ipcRenderer.invoke('manifests:list'),
    remove: (appId) => ipcRenderer.invoke('manifests:remove', appId)
  },
  limits: {
    autoInstallQuota: () => ipcRenderer.invoke('limits:autoInstallQuota')
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    downloadAndInstall: () => ipcRenderer.invoke('updates:downloadAndInstall')
  },
  activity: {
    list: () => ipcRenderer.invoke('activity:list'),
    add: (entry) => ipcRenderer.invoke('activity:add', entry),
    clear: () => ipcRenderer.invoke('activity:clear')
  },
  external: {
    open: (url) => ipcRenderer.invoke('external:open', url)
  },
  onDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('download-progress-proxy', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("download-progress", listener);
    return () => ipcRenderer.removeListener("download-progress", listener);
  },
  onUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update-progress', listener);
    return () => ipcRenderer.removeListener('update-progress', listener);
  }
});
