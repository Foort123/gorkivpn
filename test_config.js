// node test_config.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const { DEFAULT_SERVER, generateSingBoxConfig, parseSSUrl } = require('./src/main/config-parser');
const { groupProcesses } = require('./src/main/processes');
const ProxyManager = require('./src/main/proxy-manager');

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
    [ss.type, ss.server_port, ss.method, ss.password],
    ['shadowsocks', 1234, 'aes-256-gcm', 'pw'],
    'профиль с password остаётся shadowsocks — свои ss:// ключи ломать нельзя'
  );
  // В аутбаунд идёт IP, а не домен: резолвер sing-box ("local") отвечает не на каждой
  // машине, и подключение вешалось на 10 с ещё до попытки хендшейка.
  assert.ok(net.isIP(ss.server), 'адрес сервера подставлен резолвленным IP');
  assert.ok(
    plain.inbounds[0].route_exclude_address.includes(`${ss.server}/32`),
    'тот же IP исключён из маршрутов TUN — иначе петля'
  );

  // Если домен не резолвится, конфиг всё равно валиден: остаётся домен как был
  const unresolvable = await generateSingBoxConfig({ ...profile, server: 'nx.invalid' });
  assert.strictEqual(
    unresolvable.outbounds.find(o => o.tag === 'proxy').server,
    'nx.invalid',
    'при отказе резолва остаётся домен, а не undefined'
  );

  // Профиль по умолчанию — VLESS + REALITY: голый shadowsocks через Railway TCP Proxy
  // режет DPI, а HTTP-вход Railway заблокирован по IP, так что остаётся маскировка
  // рукопожатия под визит на посторонний сайт.
  const def = await generateSingBoxConfig({});
  const vl = def.outbounds.find(o => o.tag === 'proxy');
  assert.strictEqual(vl.type, 'vless', 'по умолчанию VLESS, а не shadowsocks');
  assert.ok(vl.uuid, 'uuid подставлен из DEFAULT_SERVER, а не потерян');
  assert.strictEqual(vl.tls.enabled, true);
  // Сертификат закреплён: без него клиент проверял бы цепочку по системным центрам
  // и самоподписанный сервер отверг бы. С ним принимается ровно наш и никакой другой.
  assert.ok(Array.isArray(vl.tls.certificate), 'сертификат закреплён на клиенте');
  assert.ok(
    vl.tls.certificate[0].includes('BEGIN CERTIFICATE'),
    'сертификат передан в PEM построчно, как ждёт sing-box'
  );
  assert.ok(
    !JSON.stringify(vl.tls).includes('PRIVATE KEY'),
    'приватный ключ в клиент не попал — он остаётся только на сервере'
  );
  assert.notStrictEqual(vl.tls.insecure, true, 'проверка сертификата не отключена');
  // Ключевое: в SNI уходит сайт прикрытия, а не наш адрес. Если сюда попадёт домен
  // сервера, вся маскировка теряет смысл — DPI прочитает его открытым текстом.
  assert.strictEqual(vl.tls.server_name, DEFAULT_SERVER.sni, 'SNI — сайт прикрытия');
  assert.notStrictEqual(vl.tls.server_name, DEFAULT_SERVER.server, 'SNI не равен адресу сервера');
  // uTLS обязателен для REALITY, без него sing-box конфиг не примет
  assert.strictEqual(vl.tls.utls.enabled, true, 'uTLS включён');
  assert.ok(singBoxAccepts(def), 'sing-box принимает конфиг профиля по умолчанию');
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

  // start() обязан ждать реального старта sing-box, а не резолвиться по таймеру:
  // иначе приложение пишет "подключено" там, где туннеля нет, и трафик отваливается.
  // TUN тут не поднять без прав администратора, поэтому проверяем на mixed-инбаунде.
  const workDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gorki-'));
  const pm = new ProxyManager(workDir, path.join(__dirname, 'bin'));
  const listens = (host) => ({
    log: { level: 'info' },
    inbounds: [{ type: 'mixed', tag: 'in', listen: host, listen_port: 18234 }],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  });

  assert.ok((await pm.start(listens('127.0.0.1'), profile)).success, 'старт резолвится');
  assert.ok(pm.isConnected);
  assert.ok(fs.readFileSync(pm.logPath, 'utf-8').includes('sing-box started'), 'лог пишется на диск');
  await pm.stop();
  assert.ok(!pm.isConnected);

  // на этот адрес не забиндиться: sing-box печатает FATAL и умирает —
  // старт обязан отвалиться ошибкой, а не мнимым "подключено"
  await assert.rejects(pm.start(listens('203.0.113.9'), profile), 'битый конфиг = отказ, а не мнимое подключение');
  await pm.stop();
  fs.rmSync(workDir, { recursive: true, force: true });

  console.log('OK');
})();
