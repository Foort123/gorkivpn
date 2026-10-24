const { ipcRenderer, clipboard } = require('electron');
const crypto = require('crypto');
const fs = require('fs');

// SHA-256 пароля вместо самого пароля. Настоящей защиты это не даёт — код клиента
// распаковывается из app.asar, — но и читать пароль глазами в исходниках не приходится.
const PASSWORD_HASH = '011339d2e317ab9491fafba23e98ba98ed86371c735fd8e7ddf5b9687c28d3da';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Замок: спрашиваем пароль один раз на устройство. Флаг живёт в localStorage,
// то есть в профиле Electron рядом с профилями VPN.
const lockOverlay = document.getElementById('lockOverlay');
const lockInput = document.getElementById('lockInput');
const lockError = document.getElementById('lockError');
const lockBtn = document.getElementById('lockBtn');

if (localStorage.getItem('unlocked_v2') !== '1') {
  lockOverlay.classList.remove('hidden');
  lockInput.focus();
}

function tryUnlock() {
  if (sha256(lockInput.value.trim()) === PASSWORD_HASH) {
    localStorage.setItem('unlocked_v2', '1');
    lockOverlay.classList.add('hidden');
  } else {
    lockError.classList.remove('hidden');
    lockInput.select();
  }
}

lockBtn.addEventListener('click', tryUnlock);
lockInput.addEventListener('input', () => lockError.classList.add('hidden'));
lockInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryUnlock();
});

// DOM Elements
const connectBtn = document.getElementById('connectBtn');
const statusText = document.getElementById('statusText');
const statusSubtext = document.getElementById('statusSubtext');
const pingValue = document.getElementById('pingValue');
const speedValue = document.getElementById('speedValue');
const profileList = document.getElementById('profileList');

// Modal Elements
const addKeyBtn = document.getElementById('addKeyBtn');
const addModal = document.getElementById('addModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const tabSub = document.getElementById('tabSub');
const tabKey = document.getElementById('tabKey');
const tabManual = document.getElementById('tabManual');
const subForm = document.getElementById('subForm');
const keyForm = document.getElementById('keyForm');
const manualForm = document.getElementById('manualForm');
const subUrlInput = document.getElementById('subUrlInput');
const btnSubmitSub = document.getElementById('btnSubmitSub');
const refreshPingBtn = document.getElementById('refreshPingBtn');
const syncSubBtn = document.getElementById('syncSubBtn');

// Split tunneling Elements
const addExcludeBtn = document.getElementById('addExcludeBtn');
const excludeList = document.getElementById('excludeList');
const procModal = document.getElementById('procModal');
const closeProcModalBtn = document.getElementById('closeProcModalBtn');
const procSearch = document.getElementById('procSearch');
const procList = document.getElementById('procList');

// Консоль
const consoleBtn = document.getElementById('consoleBtn');
const consolePanel = document.getElementById('consolePanel');
const consoleOut = document.getElementById('consoleOut');
const copyLogBtn = document.getElementById('copyLogBtn');

const CLASH_API = 'http://127.0.0.1:9090';

// State
let profiles = [];
let activeProfile = null;
let isConnected = false;
let speedTimer = null;
let trafficWs = null;
let allProcesses = [];
let applyTimer = null;
let logPath = null;
// Намеренно только в памяти: список выбирается заново после каждого перезапуска
let excluded = [];

// --- Консоль -------------------------------------------------------------
// Причина отказа всегда была в логе sing-box, но за ним приходилось идти руками
// в userData. Панель показывает шаги клиента и хвост этого лога рядом, а на
// ошибке открывается сама — чтобы «не подключается» сразу имело объяснение.
const appLog = [];
let consoleTimer = null;

function isConsoleOpen() {
  return !consolePanel.classList.contains('hidden');
}

function pushLog(line) {
  appLog.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (appLog.length > 200) appLog.shift();
  if (isConsoleOpen()) renderConsole();
}

function readSingBoxLog() {
  if (!logPath) return '(путь к логу ещё не получен)';
  try {
    // ProxyManager обнуляет лог на каждом старте, поэтому в файле только текущая попытка
    return fs.readFileSync(logPath, 'utf-8').split('\n').slice(-300).join('\n');
  } catch (e) {
    return '(sing-box ещё ни разу не запускался)';
  }
}

function renderConsole() {
  // прокрутку не дёргаем, если лог листают руками
  const atBottom = consoleOut.scrollHeight - consoleOut.scrollTop - consoleOut.clientHeight < 24;
  consoleOut.textContent = `${appLog.join('\n')}\n\n--- sing-box ---\n${readSingBoxLog()}`;
  if (atBottom) consoleOut.scrollTop = consoleOut.scrollHeight;
}

function showConsole(show) {
  consolePanel.classList.toggle('hidden', !show);
  clearInterval(consoleTimer);
  consoleTimer = show ? setInterval(renderConsole, 1000) : null;
  if (show) {
    renderConsole();
    consoleOut.scrollTop = consoleOut.scrollHeight;
  }
}

consoleBtn.addEventListener('click', () => showConsole(!isConsoleOpen()));

copyLogBtn.addEventListener('click', () => {
  clipboard.writeText(consoleOut.textContent);
  copyLogBtn.textContent = 'Скопировано';
  setTimeout(() => { copyLogBtn.textContent = 'Копировать'; }, 1500);
});

// Initialize App
async function init() {
  profiles = await ipcRenderer.invoke('get-profiles');
  if (profiles.length > 0) {
    activeProfile = profiles[0];
  }

  const status = await ipcRenderer.invoke('get-status');
  isConnected = status.isConnected;
  logPath = status.logPath;
  pushLog(`Клиент запущен. Лог sing-box: ${logPath}`);
  if (activeProfile) pushLog(`Активный сервер: ${activeProfile.server}:${activeProfile.port}`);
  if (status.currentProfile) {
    activeProfile = status.currentProfile;
  }

  updateUIState();
  renderProfiles();
  renderExcluded();

  // Автоматический замер и сортировка по лучшему пингу при старте
  if (!isConnected) {
    setTimeout(pingAllProfilesAndSort, 400);
  } else {
    checkPing();
  }
}

function updateUIState() {
  document.body.classList.remove('connecting', 'connected');

  if (isConnected) {
    document.body.classList.add('connected');
    statusText.textContent = 'ПОДКЛЮЧЕНО';
    statusSubtext.textContent = activeProfile ? `Маршрутизация через ${activeProfile.name}` : 'Защищенное соединение активно';
    startSpeedMeter();
  } else {
    statusText.textContent = 'ОТКЛЮЧЕНО';
    statusSubtext.textContent = 'Нажмите на кнопку для защиты соединения';
    stopSpeedMeter();
    speedValue.textContent = '0.0 KB/s';
  }
}

function getPingBadge(p) {
  if (typeof p.ping === 'number') {
    if (p.ping > 0 && p.ping < 120) {
      return `<span class="profile-ping" id="ping-${p.id}" style="color:#10b981; font-weight:700;">⚡ ${p.ping} ms</span>`;
    } else if (p.ping > 0 && p.ping < 250) {
      return `<span class="profile-ping" id="ping-${p.id}" style="color:#f59e0b; font-weight:600;">${p.ping} ms</span>`;
    } else if (p.ping > 0) {
      return `<span class="profile-ping" id="ping-${p.id}" style="color:#ef4444;">${p.ping} ms</span>`;
    } else if (p.ping === -1) {
      return `<span class="profile-ping" id="ping-${p.id}" style="color:var(--text-muted); opacity:0.6;">Таймаут</span>`;
    }
  }
  return `<span class="profile-ping" id="ping-${p.id}">-- ms</span>`;
}

function renderProfiles() {
  profileList.innerHTML = '';

  profiles.forEach(p => {
    const item = document.createElement('div');
    item.className = `profile-item ${activeProfile && activeProfile.id === p.id ? 'active' : ''}`;
    const proto = (p.protocol || 'SS').toUpperCase();
    
    item.innerHTML = `
      <div class="profile-info">
        <span class="profile-name">
          <span style="font-size:0.65rem; padding:2px 6px; border-radius:4px; margin-right:6px; background:rgba(255,122,24,0.18); color:var(--primary-glow); font-weight:700;">${proto}</span>
          ${p.name || 'VPN Сервер'}
        </span>
        <span class="profile-host">${p.server}:${p.port}</span>
      </div>
      ${getPingBadge(p)}
    `;

    item.addEventListener('click', () => {
      if (!isConnected) {
        activeProfile = p;
        renderProfiles();
        checkPing();
      }
    });

    profileList.appendChild(item);
  });
}

let isPingingAll = false;

// Замер всех серверов и сортировка: лучший пинг и связь — сверху
async function pingAllProfilesAndSort() {
  if (isConnected) {
    checkPing();
    return;
  }
  if (isPingingAll) return;
  isPingingAll = true;

  if (refreshPingBtn) {
    refreshPingBtn.disabled = true;
    refreshPingBtn.textContent = 'Замер...';
  }

  try {
    // Параллельный замер доступности всех серверов
    await Promise.all(profiles.map(async (p) => {
      try {
        const ms = await ipcRenderer.invoke('ping-server', { server: p.server, port: p.port });
        p.ping = ms > 0 ? ms : -1;
      } catch (e) {
        p.ping = -1;
      }
    }));

    // Сортировка: лучшие серверы (минимальный пинг) наверх, таймауты вниз
    profiles.sort((a, b) => {
      const pa = (typeof a.ping === 'number' && a.ping > 0) ? a.ping : 99999;
      const pb = (typeof b.ping === 'number' && b.ping > 0) ? b.ping : 99999;
      return pa - pb;
    });

    if (!isConnected && profiles.length > 0) {
      if (!activeProfile || activeProfile.ping === -1 || !profiles.some(p => p.id === activeProfile.id)) {
        activeProfile = profiles[0];
      }
    }

    renderProfiles();

    if (activeProfile && activeProfile.ping > 0) {
      pingValue.textContent = `${activeProfile.ping} ms`;
    }
  } catch (err) {
    console.error('Error in pingAllProfilesAndSort:', err);
  } finally {
    isPingingAll = false;
    if (refreshPingBtn) {
      refreshPingBtn.disabled = false;
      refreshPingBtn.textContent = 'Тест пинга';
    }
  }
}

// В подключённом состоянии замер отдаёт sing-box через clash_api (HTTP 204 до Cloudflare)
async function measureLatency() {
  if (isConnected) {
    try {
      const url = encodeURIComponent('http://cp.cloudflare.com/generate_204');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(`${CLASH_API}/proxies/proxy/delay?timeout=3000&url=${url}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) return -1;
      const data = await res.json();
      return data.delay > 0 ? data.delay : -1;
    } catch (e) {
      return -1;
    }
  }
  if (!activeProfile) return -1;
  return ipcRenderer.invoke('ping-server', {
    server: activeProfile.server,
    port: activeProfile.port
  });
}

async function checkPing() {
  if (!activeProfile) return;
  pingValue.textContent = '... ms';

  let latency = -1;
  try {
    latency = await measureLatency();
  } catch (e) {
    latency = -1;
  }

  if (latency > 0) {
    activeProfile.ping = latency;
    pingValue.textContent = `${latency} ms`;
    const pingBadge = document.getElementById(`ping-${activeProfile.id}`);
    if (pingBadge) {
      pingBadge.textContent = latency < 120 ? `⚡ ${latency} ms` : `${latency} ms`;
      pingBadge.style.color = latency < 120 ? '#10b981' : (latency < 250 ? '#f59e0b' : '#ef4444');
    }
    if (isConnected) {
      statusSubtext.textContent = `Подключено к ${activeProfile.name}`;
    }
  } else {
    activeProfile.ping = -1;
    pingValue.textContent = 'Таймаут';
    if (isConnected) {
      statusSubtext.textContent = `Сервер не отвечает. Попробуйте другой сервер из списка.`;
    }
  }
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

// Clash API шлёт {"up":N,"down":N} раз в секунду - это байты за последнюю секунду
function connectTrafficSocket() {
  trafficWs = new WebSocket(`${CLASH_API.replace('http', 'ws')}/traffic`);

  trafficWs.onmessage = (event) => {
    const t = JSON.parse(event.data);
    speedValue.textContent = `↓ ${formatSpeed(t.down)}`;
    speedValue.title = `Приём ${formatSpeed(t.down)} / Отдача ${formatSpeed(t.up)}`;
  };

  trafficWs.onclose = () => {
    trafficWs = null;
    // API поднимается чуть позже туннеля - переподключаемся, пока VPN активен
    if (isConnected) setTimeout(connectTrafficSocket, 2000);
  };
}

function startSpeedMeter() {
  stopSpeedMeter();
  speedValue.textContent = '0.0 KB/s';
  connectTrafficSocket();
  speedTimer = setInterval(checkPing, 10000);
}

function stopSpeedMeter() {
  if (speedTimer) clearInterval(speedTimer);
  speedTimer = null;
  if (trafficWs) {
    const ws = trafficWs;
    trafficWs = null;
    ws.onclose = null;
    ws.close();
  }
}

// Split tunneling
function renderExcluded() {
  excludeList.innerHTML = '';

  excluded.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'profile-item';
    item.innerHTML = `
      <div class="profile-info">
        <span class="profile-name">${entry.label || entry.exe}</span>
        <span class="profile-host">${entry.exe} — мимо туннеля</span>
      </div>
      <button class="remove-btn" title="Убрать из исключений">&times;</button>
    `;

    item.querySelector('.remove-btn').addEventListener('click', () => {
      excluded = excluded.filter(e => e !== entry);
      renderExcluded();
      scheduleApply();
    });

    excludeList.appendChild(item);
  });
}

function renderProcList() {
  const q = procSearch.value.trim().toLowerCase();
  const taken = new Set(excluded.map(e => e.exe));
  const matched = allProcesses.filter(p =>
    !taken.has(p.exe) &&
    (!q || p.exe.toLowerCase().includes(q) || p.label.toLowerCase().includes(q))
  );

  procList.innerHTML = '';
  let group = null;

  matched.slice(0, 300).forEach(p => {
    // приложения (есть окно) сверху, фон - ниже, как в диспетчере задач
    const current = p.app ? 'Приложения' : 'Фоновые процессы';
    if (current !== group) {
      group = current;
      const header = document.createElement('div');
      header.className = 'proc-group';
      header.textContent = group;
      procList.appendChild(header);
    }

    const item = document.createElement('div');
    item.className = 'profile-item';
    item.innerHTML = `
      <div class="profile-info">
        <span class="profile-name">${p.label}</span>
        <span class="profile-host">${p.exe}${p.count > 1 ? ` · ${p.count} процессов` : ''}</span>
      </div>
    `;

    item.addEventListener('click', () => {
      excluded.push({ exe: p.exe, label: p.label });
      procModal.classList.add('hidden');
      renderExcluded();
      scheduleApply();
    });

    procList.appendChild(item);
  });

  if (!matched.length) {
    procList.innerHTML = '<div class="profile-item">Ничего не найдено</div>';
  }
}

// Правила живут в конфиге, поэтому применяются перезапуском sing-box.
// Дебаунс, чтобы правка списка подряд не стоила нескольких рестартов.
function scheduleApply() {
  if (!isConnected) return;
  clearTimeout(applyTimer);
  statusSubtext.textContent = 'Применение исключений...';
  applyTimer = setTimeout(applyExclusions, 1500);
}

async function applyExclusions() {
  if (!isConnected) return;
  await ipcRenderer.invoke('disconnect-vpn');
  const res = await ipcRenderer.invoke('connect-vpn', activeProfile, excluded);
  isConnected = !!res.success;
  updateUIState();
  if (!res.success) {
    statusSubtext.textContent = res.error || 'Не удалось применить исключения';
    pushLog(`ОШИБКА при применении исключений: ${res.error || 'причина не указана'}`);
    showConsole(true);
  }
}

addExcludeBtn.addEventListener('click', async () => {
  procModal.classList.remove('hidden');
  procSearch.value = '';
  procList.innerHTML = '<div class="profile-item">Загрузка списка процессов...</div>';
  allProcesses = await ipcRenderer.invoke('list-processes');
  renderProcList();
  procSearch.focus();
});

closeProcModalBtn.addEventListener('click', () => procModal.classList.add('hidden'));
procSearch.addEventListener('input', renderProcList);

// Connect / Disconnect Action
connectBtn.addEventListener('click', async () => {
  if (isConnected) {
    // Disconnect
    statusText.textContent = 'ОТКЛЮЧЕНИЕ...';
    const res = await ipcRenderer.invoke('disconnect-vpn');
    if (res.success) {
      isConnected = false;
      updateUIState();
    }
  } else {
    // Connect
    if (!activeProfile) {
      alert('Пожалуйста, выберите или добавьте сервер');
      return;
    }

    document.body.classList.add('connecting');
    statusText.textContent = 'ПОДКЛЮЧЕНИЕ...';
    statusSubtext.textContent = `Установление туннеля к ${activeProfile.server}`;
    pushLog(`Подключение к ${activeProfile.server}:${activeProfile.port}${excluded.length ? `, мимо туннеля: ${excluded.map(e => e.exe).join(', ')}` : ''}`);

    const res = await ipcRenderer.invoke('connect-vpn', activeProfile, excluded);
    if (res.success) {
      isConnected = true;
      pushLog('Туннель поднят');
      updateUIState();
    } else {
      document.body.classList.remove('connecting');
      statusText.textContent = 'ОШИБКА';
      statusSubtext.textContent = res.error || 'Не удалось подключиться к серверу';
      pushLog(`ОШИБКА: ${res.error || 'причина не указана'}`);
      // Открываем консоль сами: иначе на экране остаётся голое «ОШИБКА»
      showConsole(true);
    }
  }
});

// Modal Logic
addKeyBtn.addEventListener('click', () => {
  addModal.classList.remove('hidden');
});

closeModalBtn.addEventListener('click', () => {
  addModal.classList.add('hidden');
});

function switchTab(activeTab, activeForm) {
  [tabSub, tabKey, tabManual].forEach(t => t && t.classList.remove('active'));
  [subForm, keyForm, manualForm].forEach(f => f && f.classList.remove('active'));
  if (activeTab) activeTab.classList.add('active');
  if (activeForm) activeForm.classList.add('active');
}

if (tabSub) tabSub.addEventListener('click', () => switchTab(tabSub, subForm));
tabKey.addEventListener('click', () => switchTab(tabKey, keyForm));
tabManual.addEventListener('click', () => switchTab(tabManual, manualForm));

// Submit Forms
if (subForm) {
  subForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = subUrlInput ? subUrlInput.value.trim() : '';
    if (btnSubmitSub) {
      btnSubmitSub.disabled = true;
      btnSubmitSub.textContent = 'Загрузка серверов...';
    }

    try {
      const res = await ipcRenderer.invoke('fetch-subscription', url);
      if (res.success) {
        profiles = res.profiles;
        const firstSub = profiles.find(p => p.isSubscription);
        if (firstSub) activeProfile = firstSub;
        renderProfiles();
        addModal.classList.add('hidden');
        checkPing();
        alert(`Успешно загружено ${res.count} рабочих узлов из GitHub Pages!`);
      } else {
        alert(`Ошибка загрузки: ${res.error}`);
      }
    } catch (err) {
      alert(`Ошибка: ${err.message}`);
    } finally {
      if (btnSubmitSub) {
        btnSubmitSub.disabled = false;
        btnSubmitSub.textContent = 'Загрузить серверы из GitHub';
      }
    }
  });
}

keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ssUrl = document.getElementById('ssUrlInput').value.trim();
  if (!ssUrl) return;

  try {
    profiles = await ipcRenderer.invoke('save-profile', { ssUrl });
    activeProfile = profiles[profiles.length - 1];
    renderProfiles();
    addModal.classList.add('hidden');
    document.getElementById('ssUrlInput').value = '';
    checkPing();
  } catch (err) {
    alert(err.message || 'Ошибка формата ключа');
  }
});

manualForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('manualName').value.trim();
  const server = document.getElementById('manualServer').value.trim();
  const port = document.getElementById('manualPort').value.trim();
  const cipher = document.getElementById('manualCipher').value.trim();
  const password = document.getElementById('manualPassword').value.trim();

  if (!server || !port || !password) {
    alert('Заполните сервер, порт и пароль');
    return;
  }

  profiles = await ipcRenderer.invoke('save-profile', {
    name, server, port, cipher, password
  });

  activeProfile = profiles[profiles.length - 1];
  renderProfiles();
  addModal.classList.add('hidden');
  checkPing();
});

if (syncSubBtn) {
  syncSubBtn.addEventListener('click', async () => {
    syncSubBtn.disabled = true;
    syncSubBtn.textContent = '⚡ Загрузка...';
    try {
      const res = await ipcRenderer.invoke('fetch-subscription');
      if (res.success) {
        profiles = res.profiles;
        const firstSub = profiles.find(p => p.isSubscription);
        if (firstSub) activeProfile = firstSub;
        renderProfiles();
        statusSubtext.textContent = `Обновлено: ${res.count} серверов с GitHub Pages`;
        pingAllProfilesAndSort();
      } else {
        alert(`Не удалось загрузить: ${res.error}`);
      }
    } catch (err) {
      alert(`Ошибка: ${err.message}`);
    } finally {
      syncSubBtn.disabled = false;
      syncSubBtn.textContent = '⚡ GitHub VPN';
    }
  });
}

refreshPingBtn.addEventListener('click', () => {
  pingAllProfilesAndSort();
});

// Listen for system status updates
ipcRenderer.on('status-changed', (event, data) => {
  isConnected = data.isConnected;
  updateUIState();
});

// Автоматическое обновление списка серверов при фоновой синхронизации с GitHub
ipcRenderer.on('profiles-updated', (event, updatedProfiles) => {
  if (Array.isArray(updatedProfiles) && updatedProfiles.length > 0) {
    profiles = updatedProfiles;
    if (!activeProfile || !profiles.some(p => p.id === activeProfile.id)) {
      activeProfile = profiles[0];
    }
    renderProfiles();
    if (!isConnected) {
      statusSubtext.textContent = `Синхронизировано: ${profiles.length} серверов с GitHub`;
      pingAllProfilesAndSort();
    } else {
      checkPing();
    }
  }
});

// Переключение из трея: жмём ту же кнопку, что и мышью в окне, чтобы не
// заводить вторую копию логики подключения.
ipcRenderer.on('tray-toggle', () => connectBtn.click());

// Run Init
init();
