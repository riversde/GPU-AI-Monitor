const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveSources: (sources) => ipcRenderer.invoke('save-sources', sources),
  loadSources: () => ipcRenderer.invoke('load-sources'),
  runNvidiaSmi: () => ipcRenderer.invoke('run-nvidia-smi'),
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  onOpenSettings: (callback) => ipcRenderer.on('open-settings', (_event) => callback()),
  setAlwaysOnTop: (enabled) => ipcRenderer.send('set-always-on-top', enabled),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
});
