// node test_config.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateSingBoxConfig, parseSSUrl } = require('./src/main/config-parser');
const { groupProcesses } = require('./src/main/processes');

const profile = { server: 'example.net', port: 1234, cipher: 'aes-256-gcm', password: 'pw' };
const singBox = path.join(__dirname, 'bin', 'sing-box.exe');
const tmp = path.join(__dirname, 'test_config.tmp.json');

function singBoxAccepts(cfg) {
  fs.writeFileSync(tmp, JSON.stringify(cfg));
  try {
    execFileSync(singBox, ['check', '-c', tmp], { stdio: 'pipe' });
    return true;
  } finally {
    fs.unlinkSync(tmp);
  }
}

(async () => {
  const plain = await generateSingBoxConfig(profile);
  const ss = plain.outbounds.find(o => o.tag === 'proxy');
  assert.deepStrictEqual(
    [ss.server, ss.server_port, ss.method, ss.password],
    ['example.net', 1234, 'aes-256-gcm', 'pw']
  );
  assert.strictEqual(plain.dns.rules[0].domain[0], 'example.net', 'домен сервера резолвится локально');
  assert.ok(!JSON.stringify(plain).includes('process_name'), 'без исключений правил процессов нет');
  assert.ok(singBoxAccepts(plain), 'sing-box принимает базовый конфиг');

  const split = await generateSingBoxConfig(profile, [{ exe: 'tg.exe' }, null, {}]);
  const routeRule = split.route.rules.find(r => r.process_name);
  assert.deepStrictEqual(routeRule.process_name, ['tg.exe'], 'записи без exe отброшены');
  assert.strictEqual(routeRule.outbound, 'direct');
  assert.strictEqual(split.dns.rules.find(r => r.process_name).server, 'local');
  // порядок важен: hijack-dns должен сработать раньше, чем процесс уйдёт в direct
  assert.ok(
    split.route.rules.findIndex(r => r.action === 'hijack-dns') <
    split.route.rules.indexOf(routeRule)
  );
  assert.ok(singBoxAccepts(split), 'sing-box принимает конфиг со split tunneling');

  // Пикер процессов: схлопывание по exe, группа "приложения" сверху
  const grouped = groupProcesses([
    { Name: 'chrome', Path: 'C:\\x\\chrome.exe', Description: 'Google Chrome', HasWindow: false },
    { Name: 'chrome', Path: 'C:\\x\\chrome.exe', Description: 'Google Chrome', HasWindow: true },
    { Name: 'svchost', Path: null, Description: null, HasWindow: false },
    { Name: 'ApplicationFrameHost', Path: 'C:\\w\\ApplicationFrameHost.exe', HasWindow: true }
  ]);
  assert.deepStrictEqual(grouped.map(g => g.exe), ['chrome.exe', 'svchost.exe'], 'оболочки скрыты');
  assert.strictEqual(grouped[0].count, 2, 'экземпляры схлопнуты в один пункт');
  assert.strictEqual(grouped[0].app, true, 'окно хотя бы у одного экземпляра = приложение');
  assert.strictEqual(grouped[1].label, 'svchost', 'без Description подписью служит имя процесса');

  const parsed = parseSSUrl('ss://' + Buffer.from('aes-256-gcm:pw').toString('base64') + '@host:99#Name');
  assert.deepStrictEqual(
    [parsed.server, parsed.port, parsed.cipher, parsed.password, parsed.name],
    ['host', 99, 'aes-256-gcm', 'pw', 'Name']
  );

  console.log('OK');
})();
