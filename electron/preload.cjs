'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('efigma', {
  start: () => ipcRenderer.invoke('hub:start'),
  stop: () => ipcRenderer.invoke('hub:stop'),
  getState: () => ipcRenderer.invoke('hub:getState'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('hub:state', listener);
    return () => ipcRenderer.removeListener('hub:state', listener);
  },
});
