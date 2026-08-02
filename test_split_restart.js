// node test_split_restart.js — VPN должен быть ВЫКЛЮЧЕН (тест поднимает свой sing-box).
// Регрессия: stop() планировал taskkill на +1000 мс и не снимал его, поэтому перезапуск
// после выбора приложения-исключения убивал уже новый процесс — UI писал "подключено",
// а пинг отваливался в "Таймаут".
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProxyManager = require('./src/main/proxy-manager');

// mixed-inbound на localhost: TUN и права администратора не нужны
const cfg = {
  log: { level: 'info', timestamp: true },
  inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: 18234 }],
  outbounds: [{ type: 'direct', tag: 'direct' }]
};

(async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvpn-'));
  const pm = new ProxyManager(appDir, path.join(__dirname, 'bin'));

  await pm.start(cfg, { name: 'test' });
  await pm.stop();
  const second = await pm.start(cfg, { name: 'test' });
  assert.ok(second.success, 'второй start не поднялся');

  const pid = pm.childProcess.pid;
  await new Promise(r => setTimeout(r, 2500)); // переживаем окно старой подстраховки

  assert.ok(pm.childProcess && pm.isConnected,
    'второй sing-box убит подстраховкой из предыдущего stop()');
  process.kill(pid, 0); // ESRCH, если процесс всё-таки мёртв

  await pm.stop();
  console.log('OK');
})();
