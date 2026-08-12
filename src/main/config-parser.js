const net = require('net');
const dns = require('dns').promises;

// Единственный источник правды по серверу по умолчанию. Раньше эти значения лежали
// копиями в index.js, config-parser.js и трёх отладочных скриптах — при каждом
// переезде часть копий забывали, и клиент шёл на снесённый хост со старым паролем.
//
// VLESS + REALITY на Railway, вход через TCP Proxy.
//
// Прежняя заметка здесь утверждала, что оба входа Railway заблокированы по адресу
// целиком. Это верно только для HTTPS-входа: TCP до 69.46.46.68:443 устанавливается,
// но TLS не начинается. Вход TCP Proxy рабочий — проверено с российского адреса
// напрямую, туннель встаёт и отдаёт 204.
//
// REALITY, а не VMess поверх WebSocket: не нужны ни свой домен, ни сертификат —
// сервер заимствует их у сайта прикрытия, и снаружи рукопожатие неотличимо от
// обычного визита туда.
const DEFAULT_SERVER = {
  server: 'altaria.proxy.rlwy.net',
  port: 17324,
  uuid: 'f771344b-1827-408b-b1d7-be97ac045049',
  reality: {
    publicKey: 'nEHvyNAVKOZXmDCxFKEcoBzn_TAaaHIgl6MzXF7HMRc',
    shortId: '40494322af7f360e',
    // Сайт прикрытия. Обязан совпадать с SNI на сервере и быть достижимым ДЛЯ СЕРВЕРА:
    // тот дозванивается туда на каждом рукопожатии. www.microsoft.com сюда не годится —
    // из контейнера Railway он недоступен, и подключение рушится целиком.
    sni: 'cloudflare-dns.com'
  }
};

/**
 * Строит аутбаунд по профилю. Профили трёх видов: наш VLESS + REALITY (есть reality),
 * VMess от прошлого переезда (есть uuid) и старые shadowsocks-ключи, добавленные
 * пользователем через ss:// — ломать их нельзя, поэтому все формы живут рядом.
 */
function buildOutbound(profile, serverAddress, serverName) {
  if (profile.reality) {
    return {
      type: 'vless',
      tag: 'proxy',
      server: serverAddress,
      server_port: parseInt(profile.port || DEFAULT_SERVER.port, 10),
      uuid: profile.uuid,
      flow: 'xtls-rprx-vision',
      tls: {
        enabled: true,
        // Имя сайта прикрытия, а не нашего сервера: по нему сервер заимствует чужой
        // сертификат, и его же видит наблюдатель. Наш домен здесь всё сломает.
        server_name: profile.reality.sni,
        // Без uTLS REALITY не проходит проверку: подделывается отпечаток Chrome.
        utls: { enabled: true, fingerprint: 'chrome' },
        reality: {
          enabled: true,
          public_key: profile.reality.publicKey,
          short_id: profile.reality.shortId
        }
      }
    };
  }

  if (profile.uuid) {
    return {
      type: 'vmess',
      tag: 'proxy',
      server: serverAddress,
      server_port: parseInt(profile.port || DEFAULT_SERVER.port, 10),
      uuid: profile.uuid,
      security: 'auto',
      alter_id: 0,
      transport: {
        type: 'ws',
        path: profile.wsPath || DEFAULT_SERVER.wsPath,
        // Host обязателен: подключаемся по IP, а edge CloudFront по нему не понимает,
        // какой сервис мы просим, и отвечает 502 ещё до контейнера.
        headers: { Host: serverName }
      },
      // Домен, а не адрес подключения: serverAddress — это уже отрезолвленный IP,
      // сертификат выписан на домен, и SNI по IP развалит рукопожатие.
      tls: {
        enabled: true,
        server_name: serverName,
        insecure: false
      }
    };
  }

  return {
    type: 'shadowsocks',
    tag: 'proxy',
    server: serverAddress,
    server_port: parseInt(profile.port, 10),
    method: profile.cipher || 'aes-256-gcm',
    password: profile.password
  };
}

/**
 * Parses an ss:// URI or raw object into standard proxy options
 */
function parseSSUrl(ssUrl) {
  if (!ssUrl || typeof ssUrl !== 'string') return null;
  try {
    let cleanUrl = ssUrl.trim();
    let tag = 'Railway VPN';

    if (cleanUrl.includes('#')) {
      const parts = cleanUrl.split('#');
      cleanUrl = parts[0];
      tag = decodeURIComponent(parts[1]) || tag;
    }

    if (!cleanUrl.startsWith('ss://')) return null;
    const body = cleanUrl.replace('ss://', '');

    // Check if format is ss://BASE64@host:port or ss://BASE64
    if (body.includes('@')) {
      const [userinfoB64, hostPort] = body.split('@');
      const decodedUserinfo = Buffer.from(userinfoB64, 'base64').toString('utf-8');
      const [method, password] = decodedUserinfo.split(':');
      const [server, portStr] = hostPort.split(':');
      const port = parseInt(portStr, 10);

      return {
        name: tag,
        server,
        port,
        cipher: method,
        password
      };
    } else {
      // Legacy ss://BASE64 format
      const decoded = Buffer.from(body, 'base64').toString('utf-8');
      const match = decoded.match(/^([^:]+):([^@]+)@([^:]+):(\d+)$/);
      if (match) {
        return {
          name: tag,
          server: match[3],
          port: parseInt(match[4], 10),
          cipher: match[1],
          password: match[2]
        };
      }
    }
  } catch (err) {
    console.error('Error parsing ss URL:', err);
  }
  return null;
}

/**
 * Generates sing-box JSON config object (schema: sing-box 1.13+)
 * @param {{exe: string}[]} excluded - приложения, которые целиком идут мимо VPN
 */
async function generateSingBoxConfig(profile, excluded = []) {
  // Профиль без своего сервера — это профиль по умолчанию: подставляем его целиком,
  // иначе от DEFAULT_SERVER возьмётся хост, а uuid и путь останутся пустыми.
  const effective = profile && profile.server ? profile : { ...DEFAULT_SERVER, ...profile };
  const server = effective.server;

  const bypass = excluded.filter(e => e && e.exe).map(e => e.exe);

  // Собственные соединения sing-box к SS-серверу нельзя пускать обратно в туннель.
  // На Wi-Fi auto_detect_interface этого не обеспечивает: пакеты уходят с LAN-адреса,
  // всё равно затягиваются в TUN и проксируются снова — петля выжирает эфемерные порты
  // (в логе с чужой машины: 671k строк и "Only one usage of each socket address" за 57 с).
  let serverIps = [];
  try {
    serverIps = net.isIP(server) ? [server] : await dns.resolve4(server);
  } catch (e) {
    console.error('Не удалось резолвить адрес сервера для direct-правила:', e.message);
  }

  return {
    log: {
      level: "trace",
      timestamp: true
    },
    dns: {
      servers: [
        // DoT через прокси — весь DNS клиента после подключения
        { tag: "remote", type: "https", server: "1.1.1.1", detour: "proxy" },
        // Резолвер для домена самого VPN-сервера и direct-приложений — системный.
        // Хардкод udp 8.8.8.8 сюда не годится: у многих провайдеров UDP:53 наружу
        // блокируется, домен VPN-сервера не резолвится и туннель не поднимается вовсе.
        { tag: "local", type: "local" }
      ],
      rules: [
        // домен VPN-сервера резолвим локально (нужен до установки туннеля)
        { domain: [server], server: "local" },
        // исключённые приложения резолвят локально, иначе получат чужую CDN-выдачу
        ...(bypass.length ? [{ process_name: bypass, server: "local" }] : []),
        // весь остальной DNS — через прокси, только A-записи (TUN без IPv6)
        { query_type: ["A", "AAAA"], server: "remote", strategy: "ipv4_only" }
      ],
      final: "local"  // fallback — прямой, если прокси ещё не поднят
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        // IPv6-адрес нужен, даже когда наружу ходим только по v4: без него у TUN нет
        // v6-маршрута, и приложение, предпочитающее IPv6 или идущее на литеральный
        // v6-адрес, уходит мимо туннеля через физический адаптер.
        address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
        mtu: 9000,
        auto_route: true,
        // strict_route: true — auto_route сам по себе только прописывает маршруты, а
        // приложение, привязавшееся к физическому адаптеру или к своему DNS, их обходит.
        // На Windows strict_route добавляет правила файрвола и закрывает лазейку.
        // Плата: при недоступном сервере интернета не будет вовсе (kill-switch) вместо
        // тихого выхода в обход туннеля.
        strict_route: true,
        // Адрес SS-сервера вообще не должен попадать в маршруты TUN. Одного route-правила
        // "ip_cidr -> direct" мало: пакет уже внутри туннеля, direct отправляет его снова,
        // он снова перехватывается — петля остаётся, только без прокси. На машине с другими
        // TUN-адаптерами (Tailscale, Radmin VPN) auto_detect_interface от этого не спасает.
        ...(serverIps.length ? { route_exclude_address: serverIps.map(ip => `${ip}/32`) } : {}),
        // mixed: TCP через system-стек (стабильнее на Windows), UDP через gvisor
        stack: "mixed"
      }
    ],
    outbounds: [
      // Подключаемся по IP, а не по домену: sing-box резолвит адрес аутбаунда своим
      // DNS, а транспорт "local" отвечает не на каждой машине — при зарезанном наружу
      // UDP:53 запрос молча висит 10 с и соединение отваливается, хотя TCP до сервера
      // проходит нормально. IP уже получен резолвером Node выше (он же идёт в anti-loop
      // правила), им и подключаемся; домен при этом остаётся в SNI и в заголовке Host,
      // иначе edge Railway не поймёт, какой сайт мы просим. Резолв делается при каждом
      // нажатии «Подключить», так что смена IP подхватится сама.
      buildOutbound(effective, serverIps[0] || server, server),
      {
        type: "direct",
        tag: "direct"
      }
    ],
    route: {
      auto_detect_interface: true,
      // default_domain_resolver резолвит домены outbound'ов (SS-сервер задан доменом)
      // strategy ipv4_only — TUN не имеет IPv6-маршрута
      default_domain_resolver: { server: "local", strategy: "ipv4_only" },
      final: "proxy",
      rules: [
        // первым: трафик к самому SS-серверу всегда мимо туннеля, иначе петля
        ...(serverIps.length ? [{ ip_cidr: serverIps, outbound: "direct" }] : []),
        { port: 53, action: "hijack-dns" },
        { ip_is_private: true, outbound: "direct" },
        // split tunneling: приложение целиком идёт напрямую, минуя туннель
        ...(bypass.length ? [{ process_name: bypass, outbound: "direct" }] : []),
        { network: "udp", port: 443, action: "reject" }
      ]
    },
    // источник реального пинга (/proxies/proxy/delay) и скорости (ws /traffic)
    experimental: {
      clash_api: {
        external_controller: "127.0.0.1:9090",
        // renderer грузится с file://, его Origin - "null"
        access_control_allow_origin: ["*"]
      }
    }
  };
}

module.exports = {
  DEFAULT_SERVER,
  buildOutbound,
  parseSSUrl,
  generateSingBoxConfig
};