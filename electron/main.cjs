// LocalAgents Studio - Electron main process
// Owns everything privileged: filesystem, PowerShell, and all network calls to Ollama nodes.
// The renderer runs sandboxed with webSecurity on and talks to this file only via IPC (see preload.cjs).

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Per-user settings live under AppData — NEVER inside the install dir or portable EXE.
// Must be set before app.ready().
(() => {
  const appData = app.getPath('appData');
  const userDataDir = path.join(appData, 'LocalAgents Studio');
  const legacyDir = path.join(appData, 'local-agents-ide');
  app.setPath('userData', userDataDir);
  try {
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
    const nextSettings = path.join(userDataDir, 'settings.json');
    const legacySettings = path.join(legacyDir, 'settings.json');
    if (!fs.existsSync(nextSettings) && fs.existsSync(legacySettings)) {
      fs.copyFileSync(legacySettings, nextSettings);
    }
  } catch (err) {
    console.warn('userData setup:', err.message);
  }
})();

let mainWindow = null;

// ==========================================
// WINDOW
// ==========================================

function createWindow() {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.localagents.studio');
  }

  const windowIcon = path.join(__dirname, 'icon.ico');
  const appTitle = `LocalAgents Studio ${app.getVersion()}`;
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: '#18181b',
    title: appTitle,
    icon: fs.existsSync(windowIcon) ? windowIcon : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });

  const distIndex = path.join(__dirname, '../dist/index.html');
  const useDevServer = process.env.VITE_DEV_SERVER === 'true' && !app.isPackaged;
  if (useDevServer || (!app.isPackaged && !fs.existsSync(distIndex))) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(distIndex);
  }

  // Warnings and errors go to the feedback log and, when present, the launching terminal.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return;
    const label = level >= 3 ? 'error' : 'warn';
    const text = `[renderer] ${message} (${sourceId}:${line})`;
    if (level >= 3) console.error(text);
    else console.warn(text);
    appendLog(label, text);
  });

  // Open external links in the default browser instead of inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

process.on('uncaughtException', err => {
  appendLog('error', `uncaughtException: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', reason => {
  const text = reason && reason.stack ? reason.stack : String(reason);
  appendLog('error', `unhandledRejection: ${text}`);
});

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});
app.on('window-all-closed', () => {
  killAllProcesses();
  app.quit();
});

const send = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

// ==========================================
// SETTINGS PERSISTENCE (userData/settings.json)
// Outside the app package — e.g. %APPDATA%\LocalAgents Studio\settings.json
// ==========================================

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

ipcMain.handle('settings:load', async () => {
  try {
    return JSON.parse(await fsp.readFile(settingsPath(), 'utf-8'));
  } catch {
    return null;
  }
});

ipcMain.handle('settings:save', async (_e, settings) => {
  try {
    await fsp.mkdir(app.getPath('userData'), { recursive: true });
    const tmp = settingsPath() + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf-8');
    await fsp.rename(tmp, settingsPath()); // atomic replace
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('settings:path', () => settingsPath());

ipcMain.handle('settings:openFolder', async () => {
  const dir = app.getPath('userData');
  await fsp.mkdir(dir, { recursive: true });
  const err = await shell.openPath(dir);
  return err ? { error: err } : { success: true, path: dir };
});

// ==========================================
// FEEDBACK LOG (userData/logs/studio.log)
// Rotates once at ~2 MB so a session can be pasted without a huge file.
// ==========================================

const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_BYTES = 200 * 1024;

function logFilePath() {
  return path.join(app.getPath('userData'), 'logs', 'studio.log');
}

function redactLog(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|password|passphrase|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]');
}

let logChain = Promise.resolve();

function appendLog(level, message) {
  const line = `${new Date().toISOString()} ${(level || 'info').toUpperCase()} ${redactLog(message).replace(/\s*\r?\n\s*/g, ' | ').slice(0, 4000)}\n`;
  logChain = logChain.then(async () => {
    const file = logFilePath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      const stat = await fsp.stat(file);
      if (stat.size >= LOG_MAX_BYTES) {
        const backup = `${file}.1`;
        await fsp.rm(backup, { force: true }).catch(() => {});
        await fsp.rename(file, backup);
      }
    } catch {
      /* file not created yet */
    }
    await fsp.appendFile(file, line, 'utf-8');
  }).catch(err => {
    console.error('log write failed:', err.message);
  });
  return logChain;
}

async function readLogTail() {
  const file = logFilePath();
  const chunks = [];
  for (const candidate of [`${file}.1`, file]) {
    try {
      const stat = await fsp.stat(candidate);
      const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
      const fh = await fsp.open(candidate, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        await fh.read(buf, 0, buf.length, start);
        chunks.push(buf.toString('utf-8'));
      } finally {
        await fh.close();
      }
    } catch {
      /* missing */
    }
  }
  const text = chunks.join('');
  return text.length > LOG_TAIL_BYTES ? text.slice(-LOG_TAIL_BYTES) : text;
}

ipcMain.handle('logs:write', async (_e, level, message) => {
  try {
    await appendLog(level || 'info', message);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('logs:readTail', async () => {
  try {
    const text = await readLogTail();
    return { success: true, text, path: logFilePath() };
  } catch (err) {
    return { error: err.message, text: '', path: logFilePath() };
  }
});

ipcMain.handle('logs:path', () => logFilePath());

ipcMain.handle('logs:openFolder', async () => {
  const dir = path.dirname(logFilePath());
  await fsp.mkdir(dir, { recursive: true });
  const err = await shell.openPath(dir);
  return err ? { error: err } : { success: true, path: dir };
});

const GITHUB_ISSUES_NEW =
  'https://github.com/HipHopGrinch/LocalAgents-Studio/issues/new';

/**
 * Build a redacted bug-report file, copy-friendly log text, and open a prefilled
 * GitHub issue in the browser (no API token in the app — user submits while signed in).
 */
ipcMain.handle('logs:reportToGitHub', async (_e, opts = {}) => {
  try {
    const version = app.getVersion();
    const note = String(opts?.note || '').trim().slice(0, 2000);
    const title = String(opts?.title || `Studio error report (v${version})`)
      .trim()
      .slice(0, 120);
    const tail = redactLog(await readLogTail());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportName = `bug-report-${stamp}.txt`;
    const reportPath = path.join(path.dirname(logFilePath()), reportName);
    const reportBody = [
      `LocalAgents Studio bug report`,
      `Version: ${version}`,
      `Electron: ${process.versions.electron || '?'}`,
      `Chrome: ${process.versions.chrome || '?'}`,
      `Node: ${process.versions.node || '?'}`,
      `OS: ${process.platform} ${os.release()} (${process.arch})`,
      `When: ${new Date().toISOString()}`,
      '',
      '## User notes',
      note || '(none)',
      '',
      '## Recent logs (redacted)',
      tail || '(empty)'
    ].join('\n');
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, reportBody, 'utf-8');

    // GitHub new-issue URLs truncate around ~8KB — keep a short body and ask to attach the file.
    const logSnippet = (tail || '').slice(-2800);
    let issueBody = [
      '## What happened',
      note || '_Describe the steps that led to the error._',
      '',
      '## Environment',
      `- App version: \`${version}\``,
      `- OS: \`${process.platform} ${os.release()} (${process.arch})\``,
      `- Electron: \`${process.versions.electron || '?'}\``,
      '',
      '## Logs',
      `A redacted report was saved on the reporter's PC as \`${reportName}\` (Hardware Settings → Open logs folder). Please paste or attach it if the snippet below is incomplete.`,
      '',
      '```text',
      logSnippet || '(no log lines yet)',
      '```'
    ].join('\n');

    let url = `${GITHUB_ISSUES_NEW}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(issueBody)}`;
    // Stay under common URL length limits
    if (url.length > 7000) {
      issueBody = [
        '## What happened',
        note || '_Describe the steps that led to the error._',
        '',
        '## Environment',
        `- App version: \`${version}\``,
        `- OS: \`${process.platform} ${os.release()} (${process.arch})\``,
        '',
        '## Logs',
        `Attach \`${reportName}\` from the Studio logs folder (full redacted report). Snippet omitted because it was too long for the issue URL.`
      ].join('\n');
      url = `${GITHUB_ISSUES_NEW}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(issueBody)}`;
    }

    await shell.openExternal(url);
    appendLog('info', `opened GitHub issue draft; report=${reportName}`);
    return {
      success: true,
      url,
      reportPath,
      reportName,
      logText: reportBody,
      version
    };
  } catch (err) {
    appendLog('error', `logs:reportToGitHub: ${err?.message || err}`);
    return { error: err.message || String(err) };
  }
});

appendLog('info', `studio start ${app.getVersion()}`);

// ==========================================
// ENCRYPTED NODE SETUP EXPORT / IMPORT
// AES-256-GCM + scrypt; passphrase never stored or logged.
// ==========================================

const NODES_EXPORT_FORMAT = 'localagents-nodes-v1';
const NODES_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const NODES_KEY_LEN = 32;
const NODES_SALT_LEN = 16;
const NODES_IV_LEN = 12;
const NODES_TAG_LEN = 16;

function stripNodeForExport(n) {
  if (!n || typeof n !== 'object') return null;
  const cfg = {
    id: String(n.id || ''),
    name: String(n.name || ''),
    url: String(n.url || ''),
    hardware: n.hardware && typeof n.hardware === 'object' ? n.hardware : {
      gpuModel: 'Unknown', vramGB: 0, ramGB: 0, ramBandwidthGBs: 0, reserveVramGB: 1
    }
  };
  if (n.type === 'ollama' || n.type === 'openai') cfg.type = n.type;
  if (typeof n.apiKey === 'string') cfg.apiKey = n.apiKey;
  if (typeof n.dnsAlias === 'string') cfg.dnsAlias = n.dnsAlias;
  if (Array.isArray(n.roles)) cfg.roles = n.roles;
  if (n.benchmarks && typeof n.benchmarks === 'object') cfg.benchmarks = n.benchmarks;
  if (Array.isArray(n.disabledModels)) cfg.disabledModels = n.disabledModels;
  if (typeof n.activeModel === 'string') cfg.activeModel = n.activeModel;
  if (n.modelMeta && typeof n.modelMeta === 'object') cfg.modelMeta = n.modelMeta;
  if (n.modelPrefs && typeof n.modelPrefs === 'object') cfg.modelPrefs = n.modelPrefs;
  if (n.freeTier === true) cfg.freeTier = true;
  if (typeof n.freeTierDailyCap === 'number' && n.freeTierDailyCap >= 1) {
    cfg.freeTierDailyCap = Math.min(500, Math.floor(n.freeTierDailyCap));
  }
  if (typeof n.freeTierRpm === 'number' && n.freeTierRpm >= 1) {
    cfg.freeTierRpm = Math.min(60, Math.floor(n.freeTierRpm));
  }
  return cfg;
}

function deriveNodesKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, NODES_KEY_LEN, NODES_SCRYPT);
}

function encryptNodesPayload(payload, passphrase) {
  const salt = crypto.randomBytes(NODES_SALT_LEN);
  const iv = crypto.randomBytes(NODES_IV_LEN);
  const key = deriveNodesKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: NODES_EXPORT_FORMAT,
    kdf: 'scrypt',
    kdfParams: { N: NODES_SCRYPT.N, r: NODES_SCRYPT.r, p: NODES_SCRYPT.p, dkLen: NODES_KEY_LEN },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: Buffer.concat([enc, tag]).toString('base64')
  };
}

function decryptNodesFile(fileObj, passphrase) {
  if (!fileObj || fileObj.format !== NODES_EXPORT_FORMAT) {
    throw new Error('Unrecognized or unsupported export format');
  }
  if (fileObj.kdf !== 'scrypt') {
    throw new Error('Unsupported key derivation');
  }
  const salt = Buffer.from(fileObj.salt, 'base64');
  const iv = Buffer.from(fileObj.iv, 'base64');
  const packed = Buffer.from(fileObj.ciphertext, 'base64');
  if (salt.length < 8 || iv.length !== NODES_IV_LEN || packed.length <= NODES_TAG_LEN) {
    throw new Error('Corrupt export file');
  }
  const data = packed.subarray(0, packed.length - NODES_TAG_LEN);
  const tag = packed.subarray(packed.length - NODES_TAG_LEN);
  const key = deriveNodesKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function validateImportedNodesPayload(payload) {
  if (!payload || payload.format !== NODES_EXPORT_FORMAT) {
    throw new Error('Invalid decrypted payload format');
  }
  if (!Array.isArray(payload.nodes)) {
    throw new Error('Export does not contain a nodes array');
  }
  const nodes = [];
  for (const raw of payload.nodes) {
    const cfg = stripNodeForExport(raw);
    if (!cfg || !cfg.id || !cfg.url) continue;
    nodes.push(cfg);
  }
  if (nodes.length === 0) {
    throw new Error('No valid nodes found in export');
  }
  return nodes;
}

ipcMain.handle('settings:exportNodes', async (_e, { nodes, passphrase } = {}) => {
  try {
    if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 4) {
      return { error: 'Passphrase must be at least 4 characters' };
    }
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return { error: 'No nodes to export' };
    }
    const sanitized = nodes.map(stripNodeForExport).filter(Boolean);
    if (sanitized.length === 0) return { error: 'No valid nodes to export' };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export encrypted node setup',
      defaultPath: 'localagents-nodes.enc',
      filters: [
        { name: 'Encrypted LocalAgents nodes', extensions: ['enc'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const inner = {
      format: NODES_EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      nodes: sanitized
    };
    const envelope = encryptNodesPayload(inner, passphrase);
    await fsp.writeFile(result.filePath, JSON.stringify(envelope, null, 2), 'utf-8');
    return { success: true, path: result.filePath, nodeCount: sanitized.length };
  } catch (err) {
    return { error: err.message || 'Export failed' };
  }
});

ipcMain.handle('settings:importNodes', async (_e, { passphrase } = {}) => {
  try {
    if (!passphrase || typeof passphrase !== 'string') {
      return { error: 'Passphrase required' };
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import encrypted node setup',
      properties: ['openFile'],
      filters: [
        { name: 'Encrypted LocalAgents nodes', extensions: ['enc'] },
        { name: 'JSON / encrypted', extensions: ['enc', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths?.length) return { canceled: true };

    const raw = await fsp.readFile(result.filePaths[0], 'utf-8');
    let fileObj;
    try {
      fileObj = JSON.parse(raw);
    } catch {
      return { error: 'File is not valid JSON' };
    }
    let payload;
    try {
      payload = decryptNodesFile(fileObj, passphrase);
    } catch {
      // Wrong passphrase or tampered ciphertext — do not leak details
      return { error: 'Decryption failed (wrong passphrase or corrupt file)' };
    }
    const nodes = validateImportedNodesPayload(payload);
    return { success: true, path: result.filePaths[0], nodes, nodeCount: nodes.length };
  } catch (err) {
    return { error: err.message || 'Import failed' };
  }
});

// ==========================================
// USER-DRIVEN FILESYSTEM (explorer / editor)
// ==========================================

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'dist-electron', 'build', 'out', '.next', '.nuxt', 'target',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.idea', '.vs', 'coverage', '.turbo', '.cache', '.localagents'
]);

async function readDirSorted(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter(e => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    .map(e => ({ name: e.name, path: path.join(dirPath, e.name), isDirectory: e.isDirectory() }));
}

ipcMain.handle('workspace:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('workspace:default', () => process.cwd());

function projectChatsPath(root) {
  return path.join(root, '.localagents', 'chats.json');
}

ipcMain.handle('project:loadChats', async (_e, root) => {
  try {
    if (!root) return { conversations: [], activeConversationId: null };
    const raw = await fsp.readFile(projectChatsPath(root), 'utf-8');
    const data = JSON.parse(raw);
    return {
      conversations: Array.isArray(data.conversations) ? data.conversations : [],
      activeConversationId: data.activeConversationId || null
    };
  } catch {
    return { conversations: [], activeConversationId: null };
  }
});

ipcMain.handle('project:saveChats', async (_e, root, payload) => {
  try {
    if (!root) return { error: 'No workspace' };
    const dir = path.join(root, '.localagents');
    await fsp.mkdir(dir, { recursive: true });
    const body = JSON.stringify({
      version: 1,
      activeConversationId: payload?.activeConversationId || null,
      conversations: Array.isArray(payload?.conversations) ? payload.conversations : []
    });
    const file = projectChatsPath(root);
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, body, 'utf-8');
    try {
      await fsp.rename(tmp, file);
    } catch {
      await fsp.copyFile(tmp, file);
      await fsp.unlink(tmp).catch(() => {});
    }
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('fs:read-dir', async (_e, dirPath) => {
  try {
    return await readDirSorted(dirPath);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('fs:read-file', async (_e, filePath) => {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size > 5 * 1024 * 1024) return { error: `File too large to open (${(stat.size / 1048576).toFixed(1)} MB)` };
    const buf = await fsp.readFile(filePath);
    if (isBinary(buf)) return { error: 'Binary file - not opened in editor' };
    return { content: buf.toString('utf-8') };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('fs:write-file', async (_e, filePath, content) => {
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('fs:create-file', async (_e, filePath) => {
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) await fsp.writeFile(filePath, '', 'utf-8');
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('fs:create-folder', async (_e, folderPath) => {
  try {
    await fsp.mkdir(folderPath, { recursive: true });
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('fs:delete', async (_e, targetPath) => {
  try {
    // Send to Recycle Bin rather than hard-deleting
    await shell.trashItem(targetPath);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('fs:reveal', (_e, targetPath) => {
  shell.showItemInFolder(targetPath);
});

function isBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

// ==========================================
// AGENT TOOLS (always scoped to the workspace root)
// ==========================================

function resolveScoped(root, p) {
  if (!root) throw new Error('No workspace folder is open');
  const abs = path.resolve(root, (p || '.').replace(/^[\\/]+(?=[^\\/])/, ''));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the workspace. Agent tools are restricted to ${root}`);
  }
  return abs;
}

const MAX_READ_CHARS = 60000;

async function toolReadFile(root, args) {
  const abs = resolveScoped(root, args.path);
  const buf = await fsp.readFile(abs);
  if (isBinary(buf)) throw new Error('File is binary');
  const text = buf.toString('utf-8');
  if (args.raw) return { content: text, path: abs };

  const lines = text.split(/\r?\n/);
  const start = Math.max(1, parseInt(args.start, 10) || 1);
  const end = Math.min(lines.length, parseInt(args.end, 10) || lines.length);
  let body = lines.slice(start - 1, end).join('\n');
  let note = '';
  if (body.length > MAX_READ_CHARS) {
    body = body.slice(0, MAX_READ_CHARS);
    note = `\n[truncated at ${MAX_READ_CHARS} chars - use start/end to read further]`;
  }
  const range = start === 1 && end === lines.length ? `${lines.length} lines` : `lines ${start}-${end} of ${lines.length}`;
  return { content: `${args.path} (${range})\n${body}${note}`, path: abs };
}

async function toolListDir(root, args) {
  const base = resolveScoped(root, args.path);
  const maxDepth = Math.min(Math.max(parseInt(args.depth, 10) || 2, 1), 5);
  const out = [];
  let count = 0;
  async function walk(dir, depth, indent) {
    if (count > 600) return;
    let entries;
    try {
      entries = await readDirSorted(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (++count > 600) {
        out.push(`${indent}... (listing truncated)`);
        return;
      }
      if (e.isDirectory) {
        out.push(`${indent}${e.name}/`);
        if (depth < maxDepth) await walk(e.path, depth + 1, indent + '  ');
      } else {
        let size = '';
        try {
          size = ` (${formatBytes((await fsp.stat(e.path)).size)})`;
        } catch {}
        out.push(`${indent}${e.name}${size}`);
      }
    }
  }
  await walk(base, 1, '');
  return { content: out.length ? out.join('\n') : '(empty directory)' };
}

async function toolSearch(root, args) {
  const base = resolveScoped(root, args.path);
  const query = args.query || '';
  if (!query) throw new Error('search requires a query');
  const useRegex = String(args.regex).toLowerCase() === 'true';
  let re;
  try {
    re = useRegex ? new RegExp(query, 'i') : null;
  } catch (err) {
    throw new Error(`Invalid regex: ${err.message}`);
  }
  const needle = query.toLowerCase();
  const results = [];
  let filesScanned = 0;
  const MAX_RESULTS = 150;

  async function walk(dir) {
    if (results.length >= MAX_RESULTS || filesScanned > 25000) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= MAX_RESULTS) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(full);
        continue;
      }
      filesScanned++;
      try {
        const stat = await fsp.stat(full);
        if (stat.size > 1024 * 1024) continue;
        const buf = await fsp.readFile(full);
        if (isBinary(buf)) continue;
        const lines = buf.toString('utf-8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (re ? re.test(line) : line.toLowerCase().includes(needle)) {
            results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 220)}`);
            if (results.length >= MAX_RESULTS) break;
          }
        }
      } catch {}
    }
  }

  const stat = await fsp.stat(base);
  if (stat.isFile()) {
    filesScanned = 0;
    const lines = (await fsp.readFile(base, 'utf-8')).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (re ? re.test(line) : line.toLowerCase().includes(needle)) results.push(`${path.relative(root, base)}:${i + 1}: ${line.trim()}`);
    });
  } else {
    await walk(base);
  }
  const suffix = results.length >= MAX_RESULTS ? `\n[stopped after ${MAX_RESULTS} matches - narrow the query or path]` : '';
  return { content: results.length ? results.join('\n') + suffix : `No matches for "${query}"` };
}

async function toolWriteFile(root, args) {
  const abs = resolveScoped(root, args.path);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, args.content ?? '', 'utf-8');
  return { content: `Wrote ${formatBytes(Buffer.byteLength(args.content ?? ''))} to ${args.path}`, path: abs };
}

ipcMain.handle('tools:exec', async (_e, root, name, args) => {
  try {
    switch (name) {
      case 'read_file': return await toolReadFile(root, args);
      case 'list_dir': return await toolListDir(root, args);
      case 'search': return await toolSearch(root, args);
      case 'write_file': return await toolWriteFile(root, args);
      case 'write_base64': {
        const abs = resolveScoped(root, args.path);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, Buffer.from(String(args.content || ''), 'base64'));
        return { content: `Wrote binary ${args.path}`, path: abs };
      }
      case 'resolve': return { path: resolveScoped(root, args.path) };
      case 'exists': return { exists: fs.existsSync(resolveScoped(root, args.path)) };
      case 'run_command': {
        const res = await runPowerShell(args.command, root, {
          timeoutMs: (args.timeoutSec || 120) * 1000,
          echo: true,
          capture: true
        });
        const tail = res.output.length > 12000 ? '[...output truncated...]\n' + res.output.slice(-12000) : res.output;
        return {
          content: `Exit code: ${res.code}${res.timedOut ? ' (timed out and was killed)' : ''}\n${tail || '(no output)'}`,
          exitCode: res.code
        };
      }
      case 'read_terminal': {
        const snap = getTerminalSnapshot(args.maxChars || 16000);
        if (args.lines) {
          const n = Math.min(Math.max(Number(args.lines) || 80, 1), 500);
          const lines = snap.content.split(/\r?\n/);
          const sliced = lines.slice(-n).join('\n');
          return {
            content: `Terminal (last ${Math.min(n, lines.length)} lines${snap.running ? ', process running' : ''}):\n${sliced}`
          };
        }
        return {
          content: `Terminal (${snap.chars} chars${snap.running ? ', process running' : ''}):\n${snap.content}`
        };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('web:search', async (_e, baseUrl, query) => {
  try {
    const base = String(baseUrl || '').trim();
    const q = String(query || '').trim();
    if (!base) {
      return { error: 'SearXNG is not configured. Set the URL in Hardware Settings and continue from local knowledge if needed.' };
    }
    if (!q) return { error: 'Empty search query' };
    const root = base.replace(/\/+$/, '');
    const url = `${root}/search?q=${encodeURIComponent(q)}&format=json`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) return { error: `SearXNG HTTP ${resp.status}` };
    const data = await resp.json();
    const results = Array.isArray(data.results) ? data.results.slice(0, 6) : [];
    if (!results.length) return { content: `No results for: ${q}` };
    const lines = results.map((r, i) => {
      const title = String(r.title || 'Untitled').slice(0, 160);
      const link = String(r.url || '');
      const snippet = String(r.content || '').replace(/\s+/g, ' ').slice(0, 280);
      return `${i + 1}. ${title}\n${link}\n${snippet}`;
    });
    return { content: lines.join('\n\n') };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('image:generate', async (_e, nodeUrl, model, prompt) => {
  try {
    const base = String(nodeUrl || '').replace(/\/+$/, '');
    const resp = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false })
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Image HTTP ${resp.status}: ${text.slice(0, 300)}` };
    }
    const data = await resp.json();
    let image = data.image || (Array.isArray(data.images) ? data.images[0] : '');
    if (image && typeof image === 'object' && image.b64_json) image = image.b64_json;
    if (typeof image === 'string' && image.includes('base64,')) image = image.split('base64,').pop();
    if (!image || typeof image !== 'string') {
      return { ok: false, error: 'Model response had no image bytes' };
    }
    return { ok: true, imageBase64: image, mime: 'image/png' };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// ==========================================
// WORKSPACE TYPECHECK (Conductor Swarm contract / repair)
// ==========================================

function findTscBinary(workspaceRoot) {
  const candidates = [
    path.join(workspaceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'),
    path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function runTsc(cwd, args, timeoutMs = 90000) {
  return new Promise(resolve => {
    const bin = findTscBinary(cwd);
    let output = '';
    let timedOut = false;
    let proc;
    try {
      if (bin) {
        proc = spawn(bin, args, { cwd, env: process.env, windowsHide: true, shell: process.platform === 'win32' });
      } else {
        // Fallback: npx tsc (may download; prefer local install)
        proc = spawn(
          process.platform === 'win32' ? 'npx.cmd' : 'npx',
          ['--no-install', 'tsc', ...args],
          { cwd, env: process.env, windowsHide: true, shell: true }
        );
      }
    } catch (err) {
      return resolve({ code: -1, output: err.message, timedOut: false, skipped: false });
    }

    const onData = d => { output += d.toString(); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, timedOut, skipped: false });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, output: output + err.message, timedOut, skipped: false });
    });
  });
}

/**
 * opts.mode: 'contract' | 'workspace'
 * opts.file: relative path for isolated contract check
 */
ipcMain.handle('workspace:typecheck', async (_e, root, opts = {}) => {
  try {
    if (!root || !fs.existsSync(root)) {
      return { ok: false, error: 'Workspace root missing', output: '' };
    }
    const mode = opts.mode || 'workspace';
    const timeoutMs = opts.timeoutMs || 90000;

    if (mode === 'contract') {
      const rel = opts.file;
      if (!rel) return { ok: false, error: 'contract file required', output: '' };
      const abs = resolveScoped(root, rel);
      if (!fs.existsSync(abs)) {
        return { ok: false, error: `Contract file not found: ${rel}`, output: '' };
      }
      // Isolated check so worker projects without a full tsconfig still validate the contract
      const args = [
        '--noEmit',
        '--pretty', 'false',
        '--strict',
        '--skipLibCheck',
        '--target', 'ES2020',
        '--module', 'ESNext',
        '--moduleResolution', 'node',
        '--esModuleInterop',
        '--jsx', 'react-jsx',
        '--lib', 'DOM,ES2020,DOM.Iterable',
        abs
      ];
      const res = await runTsc(root, args, timeoutMs);
      const tail = (res.output || '').slice(-14000);
      return {
        ok: res.code === 0 && !res.timedOut,
        code: res.code,
        output: tail || (res.code === 0 ? '' : 'tsc failed with no output'),
        timedOut: res.timedOut,
        mode: 'contract'
      };
    }

    const tsconfig = path.join(root, 'tsconfig.json');
    if (!fs.existsSync(tsconfig)) {
      return {
        ok: true,
        skipped: true,
        output: 'No tsconfig.json in workspace — skipped full project typecheck',
        mode: 'workspace'
      };
    }
    const res = await runTsc(root, ['--noEmit', '--pretty', 'false'], timeoutMs);
    const tail = (res.output || '').slice(-16000);
    return {
      ok: res.code === 0 && !res.timedOut,
      code: res.code,
      output: tail,
      timedOut: res.timedOut,
      skipped: false,
      mode: 'workspace'
    };
  } catch (err) {
    return { ok: false, error: err.message, output: err.message };
  }
});

// ==========================================
// POWERSHELL EXECUTION
// ==========================================

const activeProcs = new Set();
const TERMINAL_BUF_MAX = 200000;
let terminalBuffer = '';

function appendTerminalBuffer(text) {
  if (!text) return;
  terminalBuffer += text;
  if (terminalBuffer.length > TERMINAL_BUF_MAX) {
    terminalBuffer = terminalBuffer.slice(-TERMINAL_BUF_MAX);
  }
}

function echoTerminal(text) {
  appendTerminalBuffer(text);
  send('terminal:output', text);
}

function getTerminalSnapshot(maxChars = 12000) {
  const limit = Math.min(Math.max(Number(maxChars) || 12000, 500), 50000);
  const text =
    terminalBuffer.length > limit ? terminalBuffer.slice(-limit) : terminalBuffer;
  return {
    content: text || '(terminal is empty)',
    running: activeProcs.size > 0,
    chars: text.length
  };
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  // proc.kill() on Windows does not kill grandchildren (npm, node, python...). taskkill /T does.
  execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => {});
}

function killAllProcesses() {
  for (const p of activeProcs) killTree(p);
  activeProcs.clear();
}

function runPowerShell(command, cwd, { timeoutMs = 0, echo = true, capture = false } = {}) {
  return new Promise(resolve => {
    let output = '';
    let timedOut = false;
    let idleTimedOut = false;
    const idleMs = 45000;
    const wrapped =
      `$env:CI='1'; $env:NONINTERACTIVE='1'; $env:TERM='dumb'; ` +
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ${command}`;
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped], {
        cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(),
        env: { ...process.env, CI: '1', NONINTERACTIVE: '1', TERM: 'dumb' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      return resolve({ code: -1, output: err.message, timedOut });
    }
    activeProcs.add(proc);
    if (echo) echoTerminal(`\n> ${command}\n`);

    let idleTimer = null;
    const bumpIdle = () => {
      if (timeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        timedOut = true;
        killTree(proc);
      }, idleMs);
    };
    bumpIdle();

    const onData = data => {
      bumpIdle();
      const text = data.toString();
      if (capture) output += text;
      if (echo) echoTerminal(text);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(proc); }, timeoutMs) : null;

    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      activeProcs.delete(proc);
      if (echo) {
        if (idleTimedOut) echoTerminal(`\n[idle timeout ${idleMs}ms — no output]\n`);
        echoTerminal(`\n[exit ${code}]\n`);
      }
      send('terminal:state', { running: activeProcs.size > 0 });
      resolve({ code, output, timedOut });
    });
    proc.on('error', err => {
      if (timer) clearTimeout(timer);
      activeProcs.delete(proc);
      resolve({ code: -1, output: output + err.message, timedOut });
    });
    send('terminal:state', { running: true });
  });
}

ipcMain.handle('terminal:execute', async (_e, command, cwd) => {
  const res = await runPowerShell(command, cwd, { echo: true });
  return { code: res.code };
});

ipcMain.handle('terminal:kill', () => {
  const had = activeProcs.size > 0;
  killAllProcesses();
  send('terminal:state', { running: false });
  return { success: had };
});

ipcMain.handle('terminal:getBuffer', (_e, opts) => getTerminalSnapshot(opts?.maxChars));

ipcMain.handle('terminal:clearBuffer', () => {
  terminalBuffer = '';
  return { success: true };
});

// ==========================================
// OLLAMA CLUSTER (all network I/O happens here, never in the renderer)
// ==========================================

async function fetchJson(url, { timeoutMs = 2500, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text().catch(() => '')}`.trim());
    const text = await resp.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

function normalizeFrontierEndpoint(rawUrl) {
  let endpoint = (rawUrl || '').trim().replace(/\/+$/, '');
  if (endpoint.includes('googleapis.com')) {
    if (!endpoint.includes('/v1beta')) {
      endpoint = `${endpoint}/v1beta`;
    }
    if (!endpoint.includes('/openai')) {
      endpoint = `${endpoint}/openai`;
    }
  }
  return endpoint;
}

async function nodeStatus(node) {
  const url = (node.url || '').replace(/\/+$/, '');
  const started = Date.now();

  // 1. OpenAI-compatible Frontier endpoint (Grok, OpenRouter, OpenAI, Gemini, etc.)
  if (node.type === 'openai' || node.apiKey) {
    try {
      const endpointUrl = normalizeFrontierEndpoint(node.url);
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6000);
      const headers = { 'Content-Type': 'application/json' };
      if (node.apiKey) {
        headers['Authorization'] = `Bearer ${node.apiKey}`;
        if (endpointUrl.includes('googleapis.com')) {
          headers['x-goog-api-key'] = node.apiKey;
        }
      }

      const resp = await fetch(`${endpointUrl}/models`, { headers, signal: controller.signal });
      clearTimeout(t);
      const latency = Date.now() - started;

      if (resp.ok) {
        const data = await resp.json();
        const modelsList = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
        const filtered = modelsList
          .map(m => typeof m === 'string' ? m : (m.id || m.name))
          .filter(name => {
            if (!name) return false;
            const lower = name.toLowerCase();
            return !lower.includes('embedding') && !lower.includes('aqa');
          });

        const isGemini = endpointUrl.includes('googleapis.com');
        const fallbackList = isGemini
          ? ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash']
          : ['gpt-4o', 'grok-2-1212', 'claude-3-5-sonnet'];

        return {
          online: true,
          latency,
          version: isGemini ? 'Google Gemini API' : 'Frontier API',
          models: (filtered.length > 0 ? filtered : fallbackList).map(name => ({
            name,
            size: 0,
            details: { family: isGemini ? 'Gemini' : 'Frontier API' }
          })),
          loaded: []
        };
      }
      return { online: false, latency: null, models: [], loaded: [], error: `HTTP ${resp.status}` };
    } catch (err) {
      return { online: false, latency: null, models: [], loaded: [], error: err.message };
    }
  }

  // 2. Local Ollama Node
  try {
    const version = await fetchJson(`${url}/api/version`, { timeoutMs: 2000 });
    const latency = Date.now() - started;
    const [tags, ps] = await Promise.all([
      fetchJson(`${url}/api/tags`, { timeoutMs: 4000 }),
      fetchJson(`${url}/api/ps`, { timeoutMs: 4000 }).catch(() => ({ models: [] }))
    ]);
    return {
      online: true,
      latency,
      version: version.version,
      models: (tags.models || []).map(m => ({
        name: m.name,
        size: m.size,
        details: m.details,
        capabilities: m.capabilities
      })),
      loaded: (ps.models || []).map(m => ({
        name: m.name,
        size: m.size,
        sizeVram: m.size_vram,
        contextLength: m.context_length,
        expiresAt: m.expires_at
      }))
    };
  } catch (err) {
    const msg =
      err.name === 'AbortError'
        ? 'Timed out reaching Ollama. On LAN nodes set OLLAMA_HOST=0.0.0.0 and allow TCP 11434 through the firewall.'
        : /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(err.message || '')
          ? `${err.message} — confirm Ollama is running and OLLAMA_HOST=0.0.0.0 for remote access (port 11434).`
          : err.message;
    return { online: false, latency: null, models: [], loaded: [], error: msg };
  }
}

ipcMain.handle('ollama:status', async (_e, nodes) => {
  // Ping every node in parallel - total wait is the slowest node, not the sum
  const entries = await Promise.all(nodes.map(async n => [n.id, await nodeStatus(n)]));
  return Object.fromEntries(entries);
});

/**
 * Ollama /api/show — used to discover thinking controls + description after a pull.
 * thinking.values: [false] means unsupported; [true,false] or named levels means controllable.
 */
ipcMain.handle('ollama:show', async (_e, url, model) => {
  const base = (url || '').replace(/\/+$/, '');
  try {
    const show = await fetchJson(`${base}/api/show`, {
      method: 'POST',
      body: { model },
      timeoutMs: 20000
    });
    let thinking;
    if (show.thinking && Array.isArray(show.thinking.values) && show.thinking.values.length > 0) {
      thinking = { values: show.thinking.values, default: show.thinking.default };
    } else if (Array.isArray(show.capabilities) && show.capabilities.includes('thinking')) {
      thinking = { values: [false, true], default: true };
    }
    const description =
      (typeof show.description === 'string' && show.description.trim()) ||
      (show.details?.family ? `${show.details.family}${show.details.parameter_size ? ` · ${show.details.parameter_size}` : ''}` : undefined);
    return {
      capabilities: show.capabilities,
      description,
      thinking,
      details: show.details
    };
  } catch (err) {
    return { error: err.message };
  }
});

const streams = new Map(); // requestId -> AbortController

async function streamNdjson(requestId, url, body, channel, onLine) {
  const controller = new AbortController();
  streams.set(requestId, controller);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch {}
      throw new Error(`HTTP ${resp.status}: ${msg}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.error) throw new Error(parsed.error);
        onLine(parsed);
      }
    }
    if (buffer.trim()) {
      try { onLine(JSON.parse(buffer)); } catch {}
    }
  } catch (err) {
    if (err.name === 'AbortError') send(channel, { requestId, type: 'aborted' });
    else send(channel, { requestId, type: 'error', error: err.message });
    return false;
  } finally {
    streams.delete(requestId);
    tryInstallWhenIdle();
  }
  return true;
}

function frontierMaxTokens(url) {
  const u = String(url || '');
  if (/googleapis\.com/i.test(u)) return 65536;
  if (/x\.ai|grok/i.test(u)) return 32768;
  return 16384;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : part?.text || part?.content || '')).join('');
  }
  return '';
}

function absorbToolCall(acc, delta) {
  const calls = delta?.tool_calls;
  if (!Array.isArray(calls)) return;
  for (const tc of calls) {
    const i = tc.index ?? 0;
    if (!acc[i]) acc[i] = { name: '', args: '' };
    if (tc.function?.name) acc[i].name += tc.function.name;
    if (typeof tc.function?.arguments === 'string') acc[i].args += tc.function.arguments;
  }
}

function writeTagsFromToolCalls(acc) {
  const chunks = [];
  for (const tool of acc) {
    if (!tool) continue;
    const name = String(tool.name || '').toLowerCase();
    let parsed = {};
    try { parsed = JSON.parse(tool.args || '{}'); } catch { parsed = {}; }
    const path = parsed.path || parsed.file_path || parsed.filepath || parsed.filename || parsed.file || parsed.target || '';
    const body = parsed.content ?? parsed.contents ?? parsed.code ?? parsed.text ?? parsed.body ?? '';
    const isWrite = /write|create_file|save_file/.test(name);
    const isEdit = /edit|patch|search_replace|str_replace/.test(name);
    if (!path || (typeof body !== 'string' && typeof body !== 'number')) continue;
    const safePath = String(path).replace(/"/g, '');
    const text = String(body);
    if (isWrite) chunks.push(`<write_file path="${safePath}">\n${text}\n</write_file>`);
    else if (isEdit) chunks.push(`<edit_file path="${safePath}">\n${text}\n</edit_file>`);
  }
  return chunks.join('\n');
}

async function streamOpenAI(requestId, url, apiKey, body, channel) {
  const controller = new AbortController();
  streams.set(requestId, controller);
  const started = Date.now();
  let firstTokenTime = 0;
  let tokenCount = 0;
  let finishReason = '';
  let full = '';
  const toolAcc = [];

  try {
    const baseUrl = normalizeFrontierEndpoint(url);
    const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      if (baseUrl.includes('googleapis.com')) {
        headers['x-goog-api-key'] = apiKey;
      }
    }

    const postCompletion = payload => fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    let payload = { ...body };
    let resp = await postCompletion(payload);

    const readErrorMessage = async response => {
      const text = await response.text().catch(() => '');
      let msg = text;
      try { msg = JSON.parse(text).error?.message || text; } catch {}
      return String(msg || text || response.statusText || '');
    };

    const isRateLimited = (status, msg) => {
      if (status === 429) return true;
      return /rate[- ]?limit|quota|resource.?exhausted|too many requests|rpm\b|requests per minute/i.test(
        String(msg || '')
      );
    };

    const retryAfterMs = (response, msg, attempt) => {
      const header = response.headers?.get?.('retry-after');
      if (header && /^\d+(\.\d+)?$/.test(header.trim())) {
        return Math.min(120000, Math.max(1000, Math.ceil(Number(header) * 1000)));
      }
      const m = String(msg || '').match(/retry-after[=:\s]+(\d+)/i)
        || String(msg || '').match(/try again in\s+(\d+(?:\.\d+)?)\s*s/i);
      if (m) return Math.min(120000, Math.max(1000, Math.ceil(Number(m[1]) * 1000)));
      return Math.min(90000, 15000 * Math.pow(2, Math.max(0, attempt)));
    };

    // Rate-limit / max_tokens recovery before streaming.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (resp.ok) break;
      const msg = await readErrorMessage(resp);
      const capRejected =
        payload.max_tokens &&
        /max_tokens|max_output_tokens|max_completion_tokens|output token|maximum tokens/i.test(msg);
      if (capRejected) {
        delete payload.max_tokens;
        resp = await postCompletion(payload);
        continue;
      }
      if (isRateLimited(resp.status, msg) && attempt < 3) {
        const waitMs = retryAfterMs(resp, msg, attempt);
        appendLog(
          'warn',
          `frontier rate limit HTTP ${resp.status}; waiting ${Math.round(waitMs / 1000)}s then retry ${attempt + 1}/3`
        );
        await new Promise(r => setTimeout(r, waitMs));
        if (controller.signal.aborted) throw new Error('Aborted');
        resp = await postCompletion(payload);
        continue;
      }
      throw new Error(`HTTP ${resp.status}: ${msg}`);
    }
    if (!resp.ok) {
      const msg = await readErrorMessage(resp);
      throw new Error(`HTTP ${resp.status}: ${msg}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') break;
        try {
          const parsed = JSON.parse(dataStr);
          const choice = parsed.choices?.[0] || {};
          const delta = choice.delta || {};
          if (choice.finish_reason) finishReason = choice.finish_reason;
          absorbToolCall(toolAcc, delta);
          let content = textFromContent(delta.content ?? delta.text ?? choice.message?.content ?? '');
          if (!content && Array.isArray(parsed.candidates?.[0]?.content?.parts)) {
            content = parsed.candidates[0].content.parts.map(part => part.text || '').join('');
          }
          const thinking = textFromContent(delta.reasoning_content || delta.thinking || '');
          if (content || thinking) {
            if (!firstTokenTime) firstTokenTime = Date.now();
            if (content) {
              full += content;
              tokenCount += Math.ceil(content.length / 4);
            }
            send(channel, { requestId, type: 'chunk', content, thinking });
          }
        } catch {}
      }
    }

    const extra = writeTagsFromToolCalls(toolAcc);
    if (extra && !/<write_file\b|<edit_file\b/i.test(full)) {
      tokenCount += Math.ceil(extra.length / 4);
      send(channel, { requestId, type: 'chunk', content: `\n${extra}\n`, thinking: '' });
    }

    const totalDuration = Date.now() - started;
    send(channel, {
      requestId,
      type: 'done',
      stats: {
        evalCount: tokenCount,
        evalDuration: (totalDuration - (firstTokenTime ? firstTokenTime - started : 0)) * 1e6,
        totalDuration: totalDuration * 1e6,
        promptEvalDuration: (firstTokenTime ? firstTokenTime - started : 0) * 1e6,
        doneReason: finishReason || undefined
      }
    });
    return true;
  } catch (err) {
    if (err.name === 'AbortError') send(channel, { requestId, type: 'aborted' });
    else send(channel, { requestId, type: 'error', error: err.message });
    return false;
  } finally {
    streams.delete(requestId);
    tryInstallWhenIdle();
  }
}

ipcMain.handle('ollama:chat', async (_e, requestId, url, body, nodeType, apiKey) => {
  const base = url.replace(/\/+$/, '');
  
  if (nodeType === 'openai' || apiKey) {
    // Translate Ollama-style messages (optional images[]) to OpenAI multimodal content parts
    const messages = (body.messages || []).map(m => {
      if (!m.images || !m.images.length) return { role: m.role, content: m.content };
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const img of m.images) {
        const url = String(img).startsWith('data:') ? img : `data:image/png;base64,${img}`;
        parts.push({ type: 'image_url', image_url: { url } });
      }
      return { role: m.role, content: parts };
    });
    const requested = Number(body.options?.num_predict);
    const openAiBody = {
      model: body.model,
      messages,
      stream: true,
      temperature: body.options?.temperature ?? 0.3,
      max_tokens: Number.isFinite(requested) && requested > 0 ? requested : frontierMaxTokens(base)
    };
    return await streamOpenAI(requestId, base, apiKey, openAiBody, 'ollama:chat-event');
  }

  let doneSent = false;
  const ok = await streamNdjson(requestId, `${base}/api/chat`, { ...body, stream: true }, 'ollama:chat-event', chunk => {
    const content = chunk.message?.content || '';
    const thinking = chunk.message?.thinking || '';
    if (content || thinking) send('ollama:chat-event', { requestId, type: 'chunk', content, thinking });
    if (chunk.done) {
      doneSent = true;
      send('ollama:chat-event', {
        requestId,
        type: 'done',
        stats: {
          evalCount: chunk.eval_count,
          evalDuration: chunk.eval_duration,
          promptEvalCount: chunk.prompt_eval_count,
          promptEvalDuration: chunk.prompt_eval_duration,
          loadDuration: chunk.load_duration,
          totalDuration: chunk.total_duration,
          doneReason: chunk.done_reason
        }
      });
    }
  });
  if (ok && !doneSent) send('ollama:chat-event', { requestId, type: 'done', stats: {} });
});

// ==========================================
// TOKEN/SEC BENCHMARK RUNNER
// ==========================================

ipcMain.handle('ollama:benchmark', async (_e, node, model) => {
  const url = (node.url || '').replace(/\/+$/, '');
  const isFrontier = node.type === 'openai' || !!node.apiKey;

  if (isFrontier) {
    const started = Date.now();
    try {
      const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (node.apiKey) headers['Authorization'] = `Bearer ${node.apiKey}`;

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Write a concise Python function to calculate fibonacci numbers.' }],
          max_tokens: 100
        }),
        signal: AbortSignal.timeout(15000)
      });

      const totalMs = Date.now() - started;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const tokens = data.usage?.completion_tokens || 80;
      const promptTokens = data.usage?.prompt_tokens || 15;
      const evalTokPerSec = Math.round(tokens / (totalMs / 1000));

      return {
        model,
        nodeId: node.id,
        evalTokens: tokens,
        evalTokPerSec,
        promptTokens,
        promptTokPerSec: Math.round(promptTokens / (totalMs / 2000)),
        loadMs: 0,
        totalMs
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  // Embedding-only models (bge-m3, nomic-embed-text) benchmark via /api/embed instead of /api/generate
  const isEmbedModel = model.toLowerCase().includes('embed') || 
                       model.toLowerCase().includes('bge-') || 
                       model.toLowerCase().includes('bge:') || 
                       model.toLowerCase().includes('mxbai');

  if (isEmbedModel) {
    const started = Date.now();
    try {
      const resp = await fetch(`${url}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: 'function calculateFibonacci(n) { return n <= 1 ? n : calculateFibonacci(n - 1) + calculateFibonacci(n - 2); }'
        }),
        signal: AbortSignal.timeout(60000)
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        let msg = errText;
        try { msg = JSON.parse(errText).error || errText; } catch {}
        throw new Error(`HTTP ${resp.status}: ${msg}`);
      }
      const data = await resp.json();
      const totalMs = Date.now() - started;
      const dim = Array.isArray(data.embeddings?.[0]) ? data.embeddings[0].length : 0;
      return {
        model,
        nodeId: node.id,
        isEmbedding: true,
        embeddingDim: dim,
        evalTokens: 0,
        evalTokPerSec: 0,
        promptTokens: 1,
        promptTokPerSec: 0,
        loadMs: Math.round((data.load_duration || 0) / 1e6),
        totalMs
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  // Local Ollama generative benchmark
  try {
    const resp = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'Write a quick Python algorithm for calculating prime numbers up to 500 with inline comments.',
        stream: false,
        options: {
          num_predict: 64,
          num_ctx: 2048,
          temperature: 0.1
        }
      }),
      signal: AbortSignal.timeout(120000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let msg = errText;
      try { msg = JSON.parse(errText).error || errText; } catch {}
      throw new Error(`HTTP ${resp.status}: ${msg}`);
    }

    const data = await resp.json();

    const evalTokPerSec = data.eval_duration ? Math.round(data.eval_count / (data.eval_duration / 1e9)) : 0;
    const promptTokPerSec = data.prompt_eval_duration ? Math.round(data.prompt_eval_count / (data.prompt_eval_duration / 1e9)) : 0;
    const loadMs = Math.round((data.load_duration || 0) / 1e6);
    const totalMs = Math.round((data.total_duration || 0) / 1e6);

    return {
      model,
      nodeId: node.id,
      evalTokens: data.eval_count || 0,
      evalTokPerSec,
      promptTokens: data.prompt_eval_count || 0,
      promptTokPerSec,
      loadMs,
      totalMs
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { error: 'Benchmark timed out after 120s. Cold weight loading or VRAM swapping took too long.' };
    }
    return { error: err.message };
  }
});

ipcMain.handle('ollama:pull', async (_e, requestId, url, model) => {
  const base = url.replace(/\/+$/, '');
  const ok = await streamNdjson(requestId, `${base}/api/pull`, { model, stream: true }, 'ollama:pull-event', chunk => {
    send('ollama:pull-event', {
      requestId,
      type: 'progress',
      status: chunk.status,
      completed: chunk.completed,
      total: chunk.total
    });
  });
  if (ok) send('ollama:pull-event', { requestId, type: 'done' });
});

ipcMain.handle('ollama:abort', (_e, requestId) => {
  const c = streams.get(requestId);
  if (c) c.abort();
  return { success: !!c };
});

ipcMain.handle('ollama:delete', async (_e, url, model) => {
  try {
    const resp = await fetch(`${url.replace(/\/+$/, '')}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Load (keep_alive>0) or unload (keep_alive=0) a model without generating anything
ipcMain.handle('ollama:keepalive', async (_e, url, model, keepAlive) => {
  try {
    await fetchJson(`${url.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      timeoutMs: 120000,
      body: { model, keep_alive: keepAlive, prompt: '', stream: false }
    });
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Look up a tag on the public Ollama registry: confirms it exists and returns the exact download size.
ipcMain.handle('registry:lookup', async (_e, tag) => {
  try {
    let [name, version] = tag.trim().split(':');
    version = version || 'latest';
    const repo = name.includes('/') ? name : `library/${name}`;
    const resp = await fetch(`https://registry.ollama.ai/v2/${repo}/manifests/${version}`, {
      headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
      signal: AbortSignal.timeout(8000)
    });
    if (resp.status === 404) return { exists: false };
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const manifest = await resp.json();
    const size = (manifest.layers || []).reduce((s, l) => s + (l.size || 0), 0);
    return { exists: true, sizeBytes: size };
  } catch (err) {
    return { error: err.message };
  }
});

// ==========================================
// LOCAL HARDWARE DETECTION
// ==========================================

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? '' : stdout.toString()));
  });
}

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('system:detect-hardware', async () => {
  const cpu = (os.cpus()[0]?.model || 'Unknown CPU').replace(/\s+/g, ' ').trim();
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);
  let gpu = '';
  let vramGB = 0;
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (smi.trim()) {
    const [name, mem] = smi.trim().split('\n')[0].split(',').map(s => s.trim());
    gpu = name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '');
    vramGB = Math.round(parseInt(mem, 10) / 1024);
  }
  // RAM speed -> approximate dual-channel bandwidth: MT/s * 8 bytes * channels
  let ramMTs = 0;
  let dimms = 0;
  const memInfo = await run('powershell.exe', [
    '-NoProfile', '-Command',
    '(Get-CimInstance Win32_PhysicalMemory | Select-Object -ExpandProperty ConfiguredClockSpeed) -join ","'
  ]);
  if (memInfo.trim()) {
    const speeds = memInfo.trim().split(',').map(Number).filter(Boolean);
    dimms = speeds.length;
    ramMTs = Math.max(...speeds, 0);
  }
  const channels = dimms >= 2 ? 2 : 1;
  const ramBandwidthGBs = ramMTs ? Math.round((ramMTs * 8 * channels) / 1000) : 0;
  return { cpu, ramGB, gpu, vramGB, ramMTs, ramBandwidthGBs };
});

// ==========================================
// HELPERS
// ==========================================

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ==========================================
// AUTO-UPDATE (NSIS install only — portable is manual)
// ==========================================

/** True when the user launched the single-file portable wrapper. */
function isPortableBuild() {
  return !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

let rendererBusy = false;
let installWhenIdle = false;
let updateCheckTimer = null;
const updateState = {
  supported: false,
  state: 'idle',
  currentVersion: app.getVersion(),
  version: null,
  percent: 0,
  message: '',
  error: null
};

function pushUpdateStatus(partial = {}) {
  Object.assign(updateState, partial);
  send('update:status', { ...updateState });
}

function appIsIdle() {
  return !rendererBusy && streams.size === 0;
}

function tryInstallWhenIdle() {
  if (!installWhenIdle) return;
  if (!appIsIdle()) {
    pushUpdateStatus({
      state: 'waiting-idle',
      message: 'Update ready. Waiting for model calls to finish before restarting.'
    });
    return;
  }
  installWhenIdle = false;
  pushUpdateStatus({ state: 'installing', message: 'Restarting to apply the update…' });
  try {
    // isSilent=false, isForceRunAfter=true — relaunch after NSIS finishes
    require('electron-updater').autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    pushUpdateStatus({
      state: 'error',
      error: err?.message || String(err),
      message: 'Could not start the installer.'
    });
  }
}

function setupAutoUpdater() {
  updateState.currentVersion = app.getVersion();

  if (!app.isPackaged) {
    pushUpdateStatus({
      supported: false,
      state: 'unsupported',
      message: 'Updates are only checked in a packaged install (not npm run dev).'
    });
    return;
  }

  if (isPortableBuild()) {
    pushUpdateStatus({
      supported: false,
      state: 'unsupported',
      message: 'Portable builds update by downloading a new exe from GitHub. Use the Setup installer for in-app updates.'
    });
    return;
  }

  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    pushUpdateStatus({
      supported: false,
      state: 'error',
      error: err?.message || String(err),
      message: 'Updater module failed to load.'
    });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Releases are currently unsigned; skip Win code-signature gate.
  if (typeof autoUpdater.verifyUpdateCodeSignature === 'boolean') {
    autoUpdater.verifyUpdateCodeSignature = false;
  }

  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'HipHopGrinch',
      repo: 'LocalAgents-Studio'
    });
  } catch (err) {
    appendLog('warn', `updater setFeedURL: ${err?.message || err}`);
  }

  autoUpdater.on('checking-for-update', () => {
    pushUpdateStatus({
      supported: true,
      state: 'checking',
      message: 'Checking GitHub for a newer release…',
      error: null
    });
  });

  autoUpdater.on('update-available', info => {
    pushUpdateStatus({
      supported: true,
      state: 'available',
      version: info?.version || null,
      percent: 0,
      message: `Version ${info?.version || '?'} is available.`,
      error: null
    });
  });

  autoUpdater.on('update-not-available', () => {
    pushUpdateStatus({
      supported: true,
      state: 'up-to-date',
      version: null,
      percent: 0,
      message: `You are on the latest version (${app.getVersion()}).`,
      error: null
    });
  });

  autoUpdater.on('download-progress', progress => {
    const percent = Math.max(0, Math.min(100, Math.round(progress?.percent || 0)));
    pushUpdateStatus({
      supported: true,
      state: 'downloading',
      percent,
      message: `Downloading update… ${percent}%`,
      error: null
    });
  });

  autoUpdater.on('update-downloaded', info => {
    pushUpdateStatus({
      supported: true,
      state: 'downloaded',
      version: info?.version || updateState.version,
      percent: 100,
      message: `Version ${info?.version || updateState.version || ''} downloaded. Will restart when idle.`,
      error: null
    });
    installWhenIdle = true;
    tryInstallWhenIdle();
  });

  autoUpdater.on('error', err => {
    appendLog('error', `updater: ${err?.message || err}`);
    pushUpdateStatus({
      supported: true,
      state: 'error',
      error: err?.message || String(err),
      message: 'Update check or download failed.'
    });
  });

  pushUpdateStatus({
    supported: true,
    state: 'idle',
    message: `Installed version ${app.getVersion()}.`
  });

  // Quiet check a few seconds after launch; user can also check manually.
  updateCheckTimer = setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      appendLog('warn', `updater check: ${err?.message || err}`);
    });
  }, 8000);
}

ipcMain.handle('update:getStatus', () => ({ ...updateState }));

ipcMain.handle('update:check', async () => {
  if (!updateState.supported) return { ...updateState };
  try {
    const { autoUpdater } = require('electron-updater');
    await autoUpdater.checkForUpdates();
  } catch (err) {
    pushUpdateStatus({
      state: 'error',
      error: err?.message || String(err),
      message: 'Update check failed.'
    });
  }
  return { ...updateState };
});

ipcMain.handle('update:download', async () => {
  if (!updateState.supported) return { ...updateState };
  if (updateState.state === 'downloading' || updateState.state === 'downloaded' || updateState.state === 'waiting-idle') {
    return { ...updateState };
  }
  try {
    pushUpdateStatus({
      state: 'downloading',
      percent: 0,
      message: 'Starting download…',
      error: null
    });
    const { autoUpdater } = require('electron-updater');
    await autoUpdater.downloadUpdate();
  } catch (err) {
    pushUpdateStatus({
      state: 'error',
      error: err?.message || String(err),
      message: 'Download failed.'
    });
  }
  return { ...updateState };
});

ipcMain.handle('update:install', async () => {
  if (!updateState.supported) return { ...updateState };
  installWhenIdle = true;
  if (updateState.state !== 'downloaded' && updateState.state !== 'waiting-idle' && updateState.state !== 'installing') {
    // Download first if needed, then install when idle via update-downloaded.
    try {
      const { autoUpdater } = require('electron-updater');
      if (updateState.state === 'available' || updateState.state === 'up-to-date' || updateState.state === 'idle') {
        pushUpdateStatus({ state: 'downloading', percent: 0, message: 'Starting download…', error: null });
        await autoUpdater.downloadUpdate();
      }
    } catch (err) {
      pushUpdateStatus({
        state: 'error',
        error: err?.message || String(err),
        message: 'Download failed.'
      });
      return { ...updateState };
    }
  }
  tryInstallWhenIdle();
  return { ...updateState };
});

ipcMain.handle('update:setBusy', (_e, busy) => {
  rendererBusy = !!busy;
  if (installWhenIdle && !rendererBusy) tryInstallWhenIdle();
  return { busy: rendererBusy, idle: appIsIdle() };
});
