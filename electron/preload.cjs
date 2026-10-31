// Bridge between the sandboxed renderer and the privileged main process.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const subscribe = channel => callback => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('electronAPI', {
  // Zoom & UI Scaling
  setZoomFactor: factor => {
    try {
      if (typeof factor === 'number' && factor >= 0.5 && factor <= 3.0) {
        webFrame.setZoomFactor(factor);
      }
    } catch (err) {
      console.warn('setZoomFactor failed:', err);
    }
  },
  getZoomFactor: () => {
    try {
      return webFrame.getZoomFactor();
    } catch {
      return 1;
    }
  },

  // Settings
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  settingsPath: () => ipcRenderer.invoke('settings:path'),
  openSettingsFolder: () => ipcRenderer.invoke('settings:openFolder'),
  writeLog: (level, message) => ipcRenderer.invoke('logs:write', level, message),
  readLogTail: () => ipcRenderer.invoke('logs:readTail'),
  logsPath: () => ipcRenderer.invoke('logs:path'),
  openLogsFolder: () => ipcRenderer.invoke('logs:openFolder'),
  exportNodes: (nodes, passphrase) => ipcRenderer.invoke('settings:exportNodes', { nodes, passphrase }),
  importNodes: passphrase => ipcRenderer.invoke('settings:importNodes', { passphrase }),

  // Workspace & user-driven filesystem
  getDefaultWorkspace: () => ipcRenderer.invoke('workspace:default'),
  loadProjectChats: root => ipcRenderer.invoke('project:loadChats', root),
  saveProjectChats: (root, payload) => ipcRenderer.invoke('project:saveChats', root, payload),
  selectFolder: () => ipcRenderer.invoke('workspace:select-folder'),
  readDir: dirPath => ipcRenderer.invoke('fs:read-dir', dirPath),
  readFile: filePath => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),
  createFile: filePath => ipcRenderer.invoke('fs:create-file', filePath),
  createFolder: folderPath => ipcRenderer.invoke('fs:create-folder', folderPath),
  deleteTarget: targetPath => ipcRenderer.invoke('fs:delete', targetPath),
  revealInExplorer: targetPath => ipcRenderer.invoke('fs:reveal', targetPath),

  // Agent tools (scoped to workspace root in the main process)
  execTool: (root, name, args) => ipcRenderer.invoke('tools:exec', root, name, args),
  typecheckWorkspace: (root, opts) => ipcRenderer.invoke('workspace:typecheck', root, opts),
  webSearch: (baseUrl, query) => ipcRenderer.invoke('web:search', baseUrl, query),
  generateImage: (url, model, prompt) => ipcRenderer.invoke('image:generate', url, model, prompt),

  // Terminal
  executeCommand: (command, cwd) => ipcRenderer.invoke('terminal:execute', command, cwd),
  killCommand: () => ipcRenderer.invoke('terminal:kill'),
  getTerminalBuffer: opts => ipcRenderer.invoke('terminal:getBuffer', opts),
  clearTerminalBuffer: () => ipcRenderer.invoke('terminal:clearBuffer'),
  onTerminalOutput: subscribe('terminal:output'),
  onTerminalState: subscribe('terminal:state'),

  // Ollama & Frontier cluster
  clusterStatus: nodes => ipcRenderer.invoke('ollama:status', nodes),
  chat: (requestId, url, body, nodeType, apiKey) => ipcRenderer.invoke('ollama:chat', requestId, url, body, nodeType, apiKey),
  benchmarkModel: (node, model) => ipcRenderer.invoke('ollama:benchmark', node, model),
  onChatEvent: subscribe('ollama:chat-event'),
  pullModel: (requestId, url, model) => ipcRenderer.invoke('ollama:pull', requestId, url, model),
  onPullEvent: subscribe('ollama:pull-event'),
  abortStream: requestId => ipcRenderer.invoke('ollama:abort', requestId),
  deleteModel: (url, model) => ipcRenderer.invoke('ollama:delete', url, model),
  setKeepAlive: (url, model, keepAlive) => ipcRenderer.invoke('ollama:keepalive', url, model, keepAlive),
  registryLookup: tag => ipcRenderer.invoke('registry:lookup', tag),
  showModel: (url, model) => ipcRenderer.invoke('ollama:show', url, model),

  // System
  detectHardware: () => ipcRenderer.invoke('system:detect-hardware'),

  // NSIS in-app updates (unsupported on portable / npm run dev)
  getUpdateStatus: () => ipcRenderer.invoke('update:getStatus'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  setUpdateBusy: busy => ipcRenderer.invoke('update:setBusy', busy),
  onUpdateStatus: subscribe('update:status')
});
