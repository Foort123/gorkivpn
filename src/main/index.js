const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const ProxyManager = require('./proxy-manager');
const { parseSSUrl, generateSingBoxConfig } = require('./config-parser');
const { listProcesses } = require('./processes');

// Новый логотип GORKIVPN — многоразмерный .ico для окна и трея
const ICON_PATH = path.join(__dirname, '..', 'renderer', 'icon.ico');

// TUN не создаётся без прав администратора, поэтому приложение перезапускает
// себя через UAC - раньше это делал start.bat
const ELEVATED_FLAG = '--elevated';

function isAdmin() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(New-Object Security.Principal.WindowsPrincipal(' +
      '[Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(\'Administrator\')"',
      { windowsHide: true }
    );
    return out.toString().trim() === 'True';
  } catch (e) {
    return false;
  }
}

function elevate() {
  // в dev у electron.exe первым аргументом идёт путь к приложению, у собранного .exe его нет
  const args = process.defaultApp ? [app.getAppPath(), ELEVATED_FLAG] : [ELEVATED_FLAG];
  const argList = ` -ArgumentList ${args.map(a => `'${a}'`).join(',')}`;
  try {
    // синхронно, чтобы поймать отказ в UAC и сказать об этом вслух
    execSync(
      `powershell -NoProfile -Command "Start-Process -FilePath '${process.execPath}'${argList} -Verb RunAs"`,
      { stdio: 'ignore', windowsHide: true }
    );
  } catch (e) {
    dialog.showErrorBox(
      'GORKIVPN',
      'Нужны права администратора: без них Windows не даёт создать VPN-адаптер.'
    );
  }
}

// Флаг-страховка: даже при осечке детекта повторного запроса UAC по кругу не будет
if (process.platform === 'win32' && !process.argv.includes(ELEVATED_FLAG) && !isAdmin()) {
  elevate();
  app.exit(0);
}

let mainWindow = null;
let tray = null;
let proxyManager = null;

const profilesFilePath = path.join(app.getPath('userData'), 'vpn_profiles.json');

// Профиль по умолчанию
const defaultProfile = {
  id: 'railway-default-1',
  name: 'GORKIVPN',
  server: 'hayabusa.proxy.rlwy.net',
  port: 43081,
  cipher: 'aes-256-gcm',
  password: 'gR45-lDTr-9oPq-zXlc',
  isDefault: true
};

function loadProfiles() {
  try {
    if (fs.existsSync(profilesFilePath)) {
      const data = JSON.parse(fs.readFileSync(profilesFilePath, 'utf-8'));
      if (Array.isArray(data) && data.length > 0) {
        data.forEach(p => {
          if (p.isDefault || p.server === 'vpn-production-9f65.up.railway.app' || p.server === 'trolley.proxy.rlwy.net' || p.server === 'sakura.proxy.rlwy.net') {
            p.server = 'hayabusa.proxy.rlwy.net';
            p.port = 43081;
          }
        });
        return data;
      }
    }
  } catch (e) {
    console.error('Failed reading stored profiles:', e);
  }
  return [defaultProfile];
}

function saveProfiles(profiles) {
  try {
    fs.writeFileSync(profilesFilePath, JSON.stringify(profiles, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed saving profiles:', e);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 720,
    resizable: false,
    icon: ICON_PATH,
    title: 'GORKIVPN',
    backgroundColor: '#08070a',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

// Пункт «Подключить/Отключить» зависит от текущего состояния, поэтому меню
// пересобирается целиком — Electron не даёт менять label у готового пункта.
function buildTrayMenu() {
  const connected = !!(proxyManager && proxyManager.isConnected);

  return Menu.buildFromTemplate([
    {
      label: 'Открыть GORKIVPN',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: connected ? 'Отключить VPN' : 'Подключить VPN',
      // Жмём ту же кнопку, что и в окне: там уже выбран профиль, собран список
      // исключений и крутится вся логика статусов. Окно при закрытии только
      // прячется, поэтому рендерер жив и когда виден один значок в трее.
      click: () => {
        if (mainWindow) mainWindow.webContents.send('tray-toggle');
      }
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: async () => {
        app.isQuitting = true;
        if (proxyManager) {
          await proxyManager.stop();
        }
        app.quit();
      }
    }
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  // Логотип GORKIVPN: берём нужный размер из .ico, чтобы иконка была чёткой
  const trayIcon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('GORKIVPN');
  tray.setContextMenu(buildTrayMenu());

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // process.resourcesPath → реальная папка resources рядом с .exe (не внутри .asar)
  // __dirname внутри asar виртуальный — path.join(__dirname,'..','..') давал двойной asar в пути
  const binDir = process.defaultApp
    ? path.join(__dirname, '..', '..', 'bin')          // dev: проект/bin
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'bin'); // prod: resources/app.asar.unpacked/bin

  // cwd для sing-box — просто нужна любая реальная папка на диске
  const appDir = app.getPath('userData');

  // Сироты от прошлого жёсткого закрытия держат порт 9090 и TUN-адаптер.
  // Зачистка по имени безопасна только здесь, до первого спавна: в stop() она убивала
  // свежий процесс, поднятый следом за перезапуском из-за исключений.
  try {
    execSync('taskkill /F /IM sing-box.exe', { stdio: 'ignore', windowsHide: true });
  } catch (e) { /* нечего убивать - нормальный случай */ }

  proxyManager = new ProxyManager(appDir, binDir);

  createWindow();
  createTray();

  // Handle IPC calls
  ipcMain.handle('get-profiles', async () => {
    return loadProfiles();
  });

  ipcMain.handle('save-profile', async (event, profileData) => {
    let profiles = loadProfiles();
    let newProfile = null;

    if (profileData.ssUrl) {
      newProfile = parseSSUrl(profileData.ssUrl);
      if (!newProfile) {
        throw new Error('Invalid ss:// key URL format');
      }
      newProfile.id = 'prof-' + Date.now();
    } else {
      newProfile = {
        id: profileData.id || 'prof-' + Date.now(),
        name: profileData.name || 'Свой сервер',
        server: profileData.server,
        port: parseInt(profileData.port, 10),
        cipher: profileData.cipher || 'aes-256-gcm',
        password: profileData.password
      };
    }

    profiles.push(newProfile);
    saveProfiles(profiles);
    return profiles;
  });

  ipcMain.handle('delete-profile', async (event, profileId) => {
    let profiles = loadProfiles();
    profiles = profiles.filter(p => p.id !== profileId);
    saveProfiles(profiles);
    return profiles;
  });

  // Список процессов для пикера исключений (в духе Cheat Engine)
  ipcMain.handle('list-processes', listProcesses);

  ipcMain.handle('connect-vpn', async (event, profile, excluded = []) => {
    try {
      const configObj = await generateSingBoxConfig(profile, excluded);
      const res = await proxyManager.start(configObj, profile);
      refreshTray();
      return res;
    } catch (err) {
      console.error('IPC connect-vpn error:', err);
      refreshTray();
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('disconnect-vpn', async () => {
    try {
      const res = await proxyManager.stop();
      refreshTray();
      return res;
    } catch (err) {
      refreshTray();
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-status', async () => {
    return {
      isConnected: proxyManager ? proxyManager.isConnected : false,
      currentProfile: proxyManager ? proxyManager.currentProfile : null,
      logPath: proxyManager ? proxyManager.logPath : null,
      localPort: 10808
    };
  });

  ipcMain.handle('ping-server', async (event, { server, port }) => {
    if (!proxyManager) return -1;
    return await proxyManager.pingServer(server, port);
  });
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  if (proxyManager) {
    await proxyManager.stop();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in tray
  }
});
