const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const isDev = !app.isPackaged;

let mainWindow = null;
let tray = null;

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadWindowBounds() {
  try {
    const data = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    if (data.windowBounds && typeof data.windowBounds.x === 'number') {
      return data.windowBounds;
    }
  } catch (e) {}
  return null;
}

function saveWindowBounds(bounds) {
  try {
    const data = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    data.windowBounds = bounds;
    fs.writeFileSync(getConfigPath(), JSON.stringify(data, null, 2));
  } catch (e) {
    // Config may not exist yet — create minimal structure
    const existing = { sources: [], refreshInterval: 2000 };
    try {
      const raw = fs.readFileSync(getConfigPath(), 'utf-8');
      Object.assign(existing, JSON.parse(raw));
    } catch {}
    existing.windowBounds = bounds;
    fs.writeFileSync(getConfigPath(), JSON.stringify(existing, null, 2));
  }
}

function createWindow() {
  const savedBounds = loadWindowBounds();
  const winOpts = {
    width: savedBounds?.width || 960,
    height: savedBounds?.height || 720,
    minWidth: 700,
    minHeight: 500,
    show: true,
    fullscreenable: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  if (savedBounds && savedBounds.x != null) {
    winOpts.x = savedBounds.x;
    winOpts.y = savedBounds.y;
  }

  mainWindow = new BrowserWindow(winOpts);

  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // Persist window bounds on move/resize
  mainWindow.on('resize', () => {
    try { saveWindowBounds(mainWindow.getBounds()); } catch {}
  });
  mainWindow.on('move', () => {
    try { saveWindowBounds(mainWindow.getBounds()); } catch {}
  });

  if (isDev) {
    mainWindow.loadFile('index.html');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile('index.html');
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  let trayIcon = null;
  const iconPath = path.join(__dirname, 'build', 'tray.png');
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) trayIcon = img;
  } catch (e) {}

  if (!trayIcon) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
      if (!img.isEmpty()) trayIcon = img;
    } catch (e) {}
  }

  if (!trayIcon) {
    // Fallback: create a simple 16x16 blue square as PNG in memory
    trayIcon = nativeImage.createFromBuffer(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVQ4jWNgGAWjYBSMglEwCkYB',
      'base64'
    ));
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('GPU Monitor for AI Workloads');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show GPU Monitor for AI Workloads', click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    }},
    { type: 'separator' },
    { label: 'Settings', click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('open-settings');
      }
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    }
  });
}

// IPC: Save sources config — also persist window bounds
ipcMain.handle('save-sources', async (_event, sources) => {
  const fs = require('fs');
  const configPath = path.join(app.getPath('userData'), 'config.json');
  // Merge with existing config to preserve windowBounds
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
  const merged = { ...existing, ...sources };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  return { ok: true };
});

// IPC: Load sources config
ipcMain.handle('load-sources', async () => {
  const fs = require('fs');
  const configPath = path.join(app.getPath('userData'), 'config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  return {
    sources: [
      { id: 'remote-gpu', name: 'Remote GPU', type: 'rocm', host: '', port: 5900, enabled: false },
      { id: 'local-nvidia', name: 'Local NVIDIA', type: 'nvidia', local: true, enabled: true },
    ],
    refreshInterval: 2000,
  };
});

// IPC: Run nvidia-smi locally
ipcMain.handle('run-nvidia-smi', async () => {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('nvidia-smi --query-gpu=name,temperature.gpu,memory.used,memory.total,power.draw,power.limit,clocks.gr,clocks.mem,utilization.gpu,fan.speed,driver_version --format=csv,noheader,nounits',
      { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ error: error.message || 'nvidia-smi not available' });
          return;
        }
        const line = stdout.trim();
        if (!line) {
          resolve({ error: 'No NVIDIA GPU detected' });
          return;
        }
        const parts = line.split(',').map(s => s.trim());
        if (parts.length < 11) {
          resolve({ error: 'Unexpected nvidia-smi output format' });
          return;
        }
        resolve({
          gpu: 0,
          name: parts[0] || 'NVIDIA GPU',
          temperature: parseFloat(parts[1]) || 0,
          memory_used: parts[2],
          memory_total: parts[3],
          power_draw: parseFloat(parts[4]) || 0,
          power_limit: parseFloat(parts[5]) || 0,
          clock_gr: parts[6],
          clock_mem: parts[7],
          utilization: parseFloat(parts[8]) || 0,
          fan_speed: parseFloat(parts[9]) || 0,
          driver_version: parts[10] || '',
        });
      });
  });
});

// IPC: Window controls from renderer
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// IPC: Always on top
ipcMain.on('set-always-on-top', (_event, enabled) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(enabled);
});

ipcMain.handle('get-always-on-top', () => {
  return mainWindow ? mainWindow.isAlwaysOnTop() : false;
});

app.whenReady().then(() => {
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
  if (mainWindow) { try { mainWindow.destroy(); } catch (e) {} mainWindow = null; }
});
