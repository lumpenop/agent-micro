const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexDesktop', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),

  getState: () => ipcRenderer.invoke('codex:getState'),
  select: (index, focus) => ipcRenderer.invoke('codex:select', index, focus),
  approve: () => ipcRenderer.invoke('codex:approve'),
  decline: () => ipcRenderer.invoke('codex:decline'),
  fork: () => ipcRenderer.invoke('codex:fork'),
  send: (text) => ipcRenderer.invoke('codex:send', text),
  setReasoning: (index) => ipcRenderer.invoke('codex:setReasoning', index),
  toggleFast: () => ipcRenderer.invoke('codex:toggleFast'),
  togglePlan: () => ipcRenderer.invoke('codex:togglePlan'),
  skill: (name) => ipcRenderer.invoke('codex:skill', name),
  newChat: () => ipcRenderer.invoke('codex:newChat'),
  desktop: (action) => ipcRenderer.invoke('codex:desktop', action),
  focusApp: () => ipcRenderer.invoke('codex:focusApp'),
  reconnect: () => ipcRenderer.invoke('codex:reconnect'),

  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('codex:state', handler);
    return () => ipcRenderer.removeListener('codex:state', handler);
  },
  onLog: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('codex:log', handler);
    return () => ipcRenderer.removeListener('codex:log', handler);
  },
});
