const { ipcRenderer } = require('electron');

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
const tabKey = document.getElementById('tabKey');
const tabManual = document.getElementById('tabManual');
const keyForm = document.getElementById('keyForm');
const manualForm = document.getElementById('manualForm');
const refreshPingBtn = document.getElementById('refreshPingBtn');

// Split tunneling Elements
const addExcludeBtn = document.getElementById('addExcludeBtn');
const excludeList = document.getElementById('excludeList');
const procModal = document.getElementById('procModal');
const closeProcModalBtn = document.getElementById('closeProcModalBtn');
const procSearch = document.getElementById('procSearch');
const procList = document.getElementById('procList');

const CLASH_API = 'http://127.0.0.1:9090';

// State
let profiles = [];
let activeProfile = null;
let isConnected = false;
let speedTimer = null;
let trafficWs = null;
let allProcesses = [];
let applyTimer = null;
// Намеренно только в памяти: список выбирается заново после каждого перезапуска
let excluded = [];

// Initialize App
async function init() {
  profiles = await ipcRenderer.invoke('get-profiles');
  if (profiles.length > 0) {
    activeProfile = profiles[0];
  }

  const status = await ipcRenderer.invoke('get-status');
  isConnected = status.isConnected;
  if (status.currentProfile) {
    activeProfile = status.currentProfile;
  }

  updateUIState();
  renderProfiles();
  renderExcluded();
  checkPing();
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

function renderProfiles() {
  profileList.innerHTML = '';

  profiles.forEach(p => {
    const item = document.createElement('div');
    item.className = `profile-item ${activeProfile && activeProfile.id === p.id ? 'active' : ''}`;
    
    item.innerHTML = `
      <div class="profile-info">
        <span class="profile-name">${p.name || 'Shadowsocks VPN'}</span>
        <span class="profile-host">${p.server}:${p.port}</span>
      </div>
      <span class="profile-ping" id="ping-${p.id}">-- ms</span>
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

// В подключённом состоянии TCP-пинг из Electron сам идёт через туннель и удваивается,
// поэтому замер отдаёт sing-box: реальный RTT до gstatic через прокси.
async function measureLatency() {
  if (isConnected) {
    const url = encodeURIComponent('http://www.gstatic.com/generate_204');
    const res = await fetch(`${CLASH_API}/proxies/proxy/delay?timeout=3000&url=${url}`);
    if (!res.ok) return -1;
    const data = await res.json();
    return data.delay > 0 ? data.delay : -1;
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
    pingValue.textContent = `${latency} ms`;
    const pingBadge = document.getElementById(`ping-${activeProfile.id}`);
    if (pingBadge) pingBadge.textContent = `${latency} ms`;
  } else {
    pingValue.textContent = 'Таймаут';
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
  if (!res.success) statusSubtext.textContent = res.error || 'Не удалось применить исключения';
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

    const res = await ipcRenderer.invoke('connect-vpn', activeProfile, excluded);
    if (res.success) {
      isConnected = true;
      updateUIState();
    } else {
      document.body.classList.remove('connecting');
      statusText.textContent = 'ОШИБКА';
      statusSubtext.textContent = res.error || 'Не удалось подключиться к серверу';
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

tabKey.addEventListener('click', () => {
  tabKey.classList.add('active');
  tabManual.classList.remove('active');
  keyForm.classList.add('active');
  manualForm.classList.remove('active');
});

tabManual.addEventListener('click', () => {
  tabManual.classList.add('active');
  tabKey.classList.remove('active');
  manualForm.classList.add('active');
  keyForm.classList.remove('active');
});

// Submit Forms
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
    alert('Ошибка формата ключа ss://');
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

refreshPingBtn.addEventListener('click', () => {
  checkPing();
});

// Listen for system status updates
ipcRenderer.on('status-changed', (event, data) => {
  isConnected = data.isConnected;
  updateUIState();
});

// Run Init
init();
