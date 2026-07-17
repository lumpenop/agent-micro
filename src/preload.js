const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload cannot require local modules — i18n lives in main via sync IPC
contextBridge.exposeInMainWorld('agentI18n', {
  t: (locale, key, vars) => ipcRenderer.sendSync('i18n:t', { locale, key, vars }),
  normalizeLocale: (locale) => ipcRenderer.sendSync('i18n:normalizeLocale', locale),
});

contextBridge.exposeInMainWorld('codexDesktop', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  suspendPadHotkeys: (suspended) => ipcRenderer.invoke('window:suspendPadHotkeys', suspended),

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
  voiceToCodex: (text) => ipcRenderer.invoke('codex:voice', text),
  focusApp: () => ipcRenderer.invoke('codex:focusApp'),
  reconnect: () => ipcRenderer.invoke('codex:reconnect'),
  connect: (opts) => ipcRenderer.invoke('codex:connect', opts),
  linkInfo: () => ipcRenderer.invoke('codex:linkInfo'),
  loginStatus: () => ipcRenderer.invoke('codex:loginStatus'),
  login: () => ipcRenderer.invoke('codex:login'),
  requestMic: () => ipcRenderer.invoke('mic:request'),
  micStatus: () => ipcRenderer.invoke('mic:status'),
  whisperReady: () => ipcRenderer.invoke('mic:whisperReady'),
  transcribe: (payload) => ipcRenderer.invoke('mic:transcribe', payload),
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  setVoiceApiKey: (key) => ipcRenderer.invoke('voice:setApiKey', key),
  skipVoiceSetup: () => ipcRenderer.invoke('voice:skipSetup'),
  openApiKeysPage: () => ipcRenderer.invoke('voice:openApiKeysPage'),
  beginVoiceDictation: () => ipcRenderer.invoke('voice:beginDictation'),
  endVoiceDictation: () => ipcRenderer.invoke('voice:endDictation'),
  getCodexSettings: () => ipcRenderer.invoke('codexSettings:get'),
  saveCodexSettings: (partial) => ipcRenderer.invoke('codexSettings:save', partial),
  writeCodexIgnore: () => ipcRenderer.invoke('codexSettings:writeIgnore'),
  openCodexConfig: () => ipcRenderer.invoke('codexSettings:openConfig'),
  getPadPrefs: () => ipcRenderer.invoke('padPrefs:get'),
  setPadPrefs: (partial) => ipcRenderer.invoke('padPrefs:set', partial),

  getTrialStatus: () => ipcRenderer.invoke('trial:get'),
  openSponsor: () => ipcRenderer.invoke('trial:openSponsor'),
  activateLicense: (key) => ipcRenderer.invoke('trial:activate', key),

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
  onMicStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('mic:status', handler);
    return () => ipcRenderer.removeListener('mic:status', handler);
  },
  onHotkey: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('hotkey', handler);
    return () => ipcRenderer.removeListener('hotkey', handler);
  },
  onPadPrefs: (cb) => {
    const handler = (_e, prefs) => cb(prefs);
    ipcRenderer.on('padPrefs:changed', handler);
    return () => ipcRenderer.removeListener('padPrefs:changed', handler);
  },
});
