// Bridge between the sandboxed renderer and the privileged main process.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = channel => callback => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  settingsPath: () => ipcRenderer.invoke('settings:path'),

  // Workspace & user-driven filesystem
  getDefaultWorkspace: () => ipcRenderer.invoke('workspace:default'),
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
  detectHardware: () => ipcRenderer.invoke('system:detect-hardware')
});
