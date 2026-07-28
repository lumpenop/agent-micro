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
  setGitPanel: (open) => ipcRenderer.invoke('window:setGitPanel', open),
  setMousePassthrough: (passthrough) => ipcRenderer.invoke('window:setMousePassthrough', passthrough),
  getGitStatus: () => ipcRenderer.invoke('git:status'),
  syncGit: (action, context) => ipcRenderer.invoke('git:sync', action, context),
  stageGitFile: (file, staged) => ipcRenderer.invoke('git:stageFile', file, staged),
  stageAllGit: () => ipcRenderer.invoke('git:stageAll'),
  unstageAllGit: () => ipcRenderer.invoke('git:unstageAll'),
  generateGitMessage: () => ipcRenderer.invoke('git:autoMessage'),
  commitGit: (message) => ipcRenderer.invoke('git:commit', message),
  listAgentTasks: () => ipcRenderer.invoke('coordinator:list'),
  createAgentTask: (input) => ipcRenderer.invoke('coordinator:create', input),
  launchAgentTask: (slot) => ipcRenderer.invoke('coordinator:launch', slot),
  mergeAgentTask: (slot) => ipcRenderer.invoke('coordinator:merge', slot),
  archiveAgentTask: (slot) => ipcRenderer.invoke('coordinator:archive', slot),
  restoreAgentTask: (slot) => ipcRenderer.invoke('coordinator:restore', slot),

  getState: () => ipcRenderer.invoke('codex:getState'),
  select: (index, focus) => ipcRenderer.invoke('codex:select', index, focus),
  approve: () => ipcRenderer.invoke('codex:approve'),
  decline: () => ipcRenderer.invoke('codex:decline'),
  fork: () => ipcRenderer.invoke('codex:fork'),
  send: (text) => ipcRenderer.invoke('codex:send', text),
  clearSelectedAgentInput: () => ipcRenderer.invoke('codex:clearInput'),
  setReasoning: (index) => ipcRenderer.invoke('codex:setReasoning', index),
  toggleFast: () => ipcRenderer.invoke('codex:toggleFast'),
  togglePlan: () => ipcRenderer.invoke('codex:togglePlan'),
  openModelPicker: () => ipcRenderer.invoke('codex:modelPicker'),
  switchActiveModel: (model) => ipcRenderer.invoke('codex:switchModel', model),
  toggleDevServer: () => ipcRenderer.invoke('devServer:toggle'),
  getDevServerStatus: () => ipcRenderer.invoke('devServer:status'),
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
  switchProvider: (provider) => ipcRenderer.invoke('codex:switchProvider', provider),
  ensureProviderTool: (provider) => ipcRenderer.invoke('tools:ensure', provider),
  beginVoiceDictation: () => ipcRenderer.invoke('voice:beginDictation'),
  endVoiceDictation: () => ipcRenderer.invoke('voice:endDictation'),
  submitVoiceText: (text) => ipcRenderer.invoke('voice:submitText', text),
  prepareVoiceCapture: () => ipcRenderer.invoke('voice:prepareCapture'),
  ensureVoiceModel: () => ipcRenderer.invoke('voice:ensureModel'),
  transcribeVoiceAudio: (bytes, mimeType) =>
    ipcRenderer.invoke('voice:transcribeAudio', bytes, mimeType),
  onVoiceModelProgress: (cb) => {
    const handler = (_e, progress) => cb(progress);
    ipcRenderer.on('voice:modelProgress', handler);
    return () => ipcRenderer.removeListener('voice:modelProgress', handler);
  },
  onProviderToolProgress: (cb) => {
    const handler = (_e, progress) => cb(progress);
    ipcRenderer.on('tools:progress', handler);
    return () => ipcRenderer.removeListener('tools:progress', handler);
  },
  getCodexSettings: () => ipcRenderer.invoke('codexSettings:get'),
  saveCodexSettings: (partial) => ipcRenderer.invoke('codexSettings:save', partial),
  chooseCodexWorkingDirectory: () => ipcRenderer.invoke('codexSettings:chooseWorkingDirectory'),
  getProjectAgentRules: (cwd) => ipcRenderer.invoke('agentRules:getProject', cwd),
  saveProjectAgentRules: (cwd, rules) => ipcRenderer.invoke('agentRules:saveProject', cwd, rules),
  getResourceUsage: () => ipcRenderer.invoke('resources:getUsage'),
  getCodexUsage: () => ipcRenderer.invoke('codex:usage'),
  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  setMcpServerOptions: (name, options) => ipcRenderer.invoke('mcp:setOptions', name, options),
  mcpCommand: (action, payload) => ipcRenderer.invoke('mcp:command', action, payload),
  listSkillsAndPlugins: () => ipcRenderer.invoke('skills:list'),
  listPersonalSkills: () => ipcRenderer.invoke('skills:personalList'),
  savePersonalSkill: (input) => ipcRenderer.invoke('skills:save', input),
  deletePersonalSkill: (name) => ipcRenderer.invoke('skills:delete', name),
  searchOnlineIcons: (query) => ipcRenderer.invoke('icons:search', query),
  fetchOnlineIcon: (id) => ipcRenderer.invoke('icons:fetch', id),
  writeCodexIgnore: () => ipcRenderer.invoke('codexSettings:writeIgnore'),
  openCodexConfig: () => ipcRenderer.invoke('codexSettings:openConfig'),
  listCodexBackups: () => ipcRenderer.invoke('codexSettings:listBackups'),
  restoreCodexBackup: (id) => ipcRenderer.invoke('codexSettings:restoreBackup', id),
  getPadPrefs: () => ipcRenderer.invoke('padPrefs:get'),
  setPadPrefs: (partial) => ipcRenderer.invoke('padPrefs:set', partial),


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
  onOpenPanel: (cb) => {
    const handler = (_e, panel) => cb(panel);
    ipcRenderer.on('app:openPanel', handler);
    return () => ipcRenderer.removeListener('app:openPanel', handler);
  },
});
