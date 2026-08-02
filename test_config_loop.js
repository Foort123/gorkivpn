// node test_config_loop.js — конфиг обязан уводить трафик к самому VPN-серверу мимо туннеля.
// Без этого правила собственные соединения sing-box возвращаются в TUN и проксируются
// снова: петля, исчерпание эфемерных портов, "Таймаут" в UI.
// Сеть не нужна: сервер задан IP-литералом, поэтому DNS не дёргается.
const assert = require('assert');
const { generateSingBoxConfig } = require('./src/main/config-parser');

(async () => {
  const cfg = await generateSingBoxConfig({ server: '203.0.113.7', port: 26350 }, []);

  // главное: адрес сервера исключён из маршрутов TUN, пакет туда физически не попадает
  assert.deepStrictEqual(cfg.inbounds[0].route_exclude_address, ['203.0.113.7/32'],
    'адрес сервера не исключён из маршрутов TUN — петля вернётся');

  // страховка на уровне правил, если пакет всё же зашёл в туннель
  assert.deepStrictEqual(cfg.route.rules[0], { ip_cidr: ['203.0.113.7'], outbound: 'direct' },
    'нет direct-правила для адреса сервера');

  // ничто не должно увести пакет в proxy раньше этого правила
  const toProxy = cfg.route.rules.findIndex(r => r.outbound === 'proxy');
  assert.ok(toProxy === -1 || toProxy > 0, 'правило proxy стоит раньше bypass сервера');
  assert.strictEqual(cfg.route.final, 'proxy');

  console.log('OK');
})();
