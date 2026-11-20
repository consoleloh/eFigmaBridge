'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { BridgeHub } = require('./bridge.cjs');

const isDev = !app.isPackaged;

// Временное файловое логирование для диагностики запуска (GUI-процесс не пишет в консоль)
const logFile = path.join(app.getPath('temp'), 'efigmabridge-main.log');
function log(msg) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}
process.on('uncaughtException', (err) => log(`uncaughtException: ${err.stack || err}`));

// Пути, которые UI показывает пользователю: адаптер для MCP-конфига LLM и манифест плагина.
// В dev — из корня проекта. В собранном portable-exe resources лежат во временной папке
// распаковки и пропадают после закрытия, поэтому копируем адаптер и плагин в стабильное
// место (%LOCALAPPDATA%\eFigmaBridge\runtime) и показываем пути туда.
const rootDir = app.getAppPath();
let adapterPath;
let manifestPath;

if (isDev) {
  adapterPath = path.join(rootDir, 'adapter', 'mcp-stdio.mjs');
  manifestPath = path.join(rootDir, 'resources', 'figma-plugin', 'manifest.json');
} else {
  const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
  const stableRoot = path.join(localAppData, 'eFigmaBridge', 'runtime');
  try {
    fs.cpSync(path.join(process.resourcesPath, 'adapter'), path.join(stableRoot, 'adapter'), { recursive: true });
    fs.cpSync(path.join(process.resourcesPath, 'figma-plugin'), path.join(stableRoot, 'figma-plugin'), { recursive: true });
    log(`runtime synced to ${stableRoot}`);
  } catch (err) {
    log(`runtime sync failed: ${err.message}`);
  }
  adapterPath = path.join(stableRoot, 'adapter', 'mcp-stdio.mjs');
  manifestPath = path.join(stableRoot, 'figma-plugin', 'manifest.json');
}

const hub = new BridgeHub();
let win = null;

function pushState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('hub:state', fullState());
  }
}

function fullState() {
  return {
    ...hub.state(),
    paths: {
      adapter: adapterPath,
      manifest: manifestPath,
      manifestExists: fs.existsSync(manifestPath),
      adapterExists: fs.existsSync(adapterPath),
    },
  };
}

hub.onChange = pushState;

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: 'eFigmaBridge',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    win.loadURL(devServer);
  } else {
    const indexFile = path.join(rootDir, 'renderer', 'dist', 'index.html');
    log(`loadFile ${indexFile} exists=${fs.existsSync(indexFile)}`);
    win.loadFile(indexFile).catch((err) => log(`loadFile failed: ${err.message}`));
  }
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`did-fail-load ${code} ${desc}`));
  win.webContents.on('did-finish-load', () => log('did-finish-load'));

  win.on('closed', () => { win = null; });
}

ipcMain.handle('hub:start', () => {
  hub.lastError = null;
  hub.start();
  return fullState();
});

ipcMain.handle('hub:stop', () => {
  hub.stop();
  return fullState();
});

ipcMain.handle('hub:getState', () => fullState());

app.whenReady().then(() => {
  log('app ready');
  createWindow();
  log('window created');
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  hub.stop();
  if (process.platform !== 'darwin') app.quit();
});
