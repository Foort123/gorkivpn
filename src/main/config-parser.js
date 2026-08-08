const net = require('net');
const dns = require('dns').promises;

// Единственный источник правды по серверу по умолчанию. Раньше эти значения лежали
// копиями в index.js, config-parser.js и трёх отладочных скриптах — при каждом
// переезде часть копий забывали, и клиент шёл на снесённый хост со старым паролем.
//
// VLESS + REALITY, а не shadowsocks. Причина не в моде на протоколы:
//
// 1. Голый shadowsocks через Railway TCP Proxy не доходит с российских сетей. Сервер
//    и ключ исправны — клиент внутри дата-центра Railway ходил через них успешно, —
//    а тот же трафик с домашней машины приходил испорченным (authentication error)
//    при совпадающих до md5 пароле и шифре. DPI узнаёт рукопожатие shadowsocks.
// 2. Путь через HTTP-домен Railway на 443 тоже отпал: его IP 69.46.46.8 заблокирован
//    целиком. TCP устанавливается, TLS не начинается — хоть с нашим именем в SNI,
//    хоть с подставленным чужим. Блокировка по адресу, не по имени.
// 3. Вход TCP Proxy (66.33.22.220) при этом рабочий, байты до контейнера доходят.
//
// Поэтому идём через рабочий вход, но обычным TLS: снаружи это рядовое https-
// соединение, а sni — имя, которое видит DPI, к нашему адресу отношения не имеет.
//
// REALITY тут был бы строже, но не работает: между двумя sing-box рукопожатие
// заканчивается "REALITY: processed invalid connection" (issue SagerNet/sing-box#4023,
// с клиентами на Xray тот же сервер работает). Воспроизвёл локально на свежей паре
// ключей, при пустом и заданном short_id, на всех отпечатках uTLS — обойти нечем.
//
// Сертификат самоподписанный и закреплён здесь целиком. Это не слабее проверки по
// цепочке, а строже: клиент принимает ровно этот сертификат и никакой другой, так что
// подменить сервер по дороге нельзя. Приватный ключ остаётся на сервере, здесь только
// публичная часть — её видит каждый, кто открывает соединение.
const DEFAULT_SERVER = {
  server: 'altaria.proxy.rlwy.net',
  port: 15525,
  uuid: '0b8c2e95-9895-49a6-8387-876272b25ae0',
  sni: 'www.microsoft.com',
  cert: `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIQUxM5PM48Zx4b7Lf/71qRYjANBgkqhkiG9w0BAQsFADAc
MRowGAYDVQQDExF3d3cubWljcm9zb2Z0LmNvbTAeFw0yNjA4MDgxNDMzMDNaFw0z
NjA4MDgxNTMzMDNaMBwxGjAYBgNVBAMTEXd3dy5taWNyb3NvZnQuY29tMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2H074kuG9vOTdzlVibW5FCsS9Npx
ybhPo0zoXKmtMO9azCWTeUyJenIf4Ad871FcN8m3xuSHirYW0VuGYuyrKVqhYuBR
27NnQXoYXCGaPlGlFTp/i5cTE7J+l989zSuewnX4nUKLIII0GBopg1ZgVLgq+5ox
StG/w5sBZFr2+FFg3cVceIM48s73kjjlPMU/oyqd//L2QK4FpLfnTEIi1ItwAb0m
24cZz2wByUBNHKMjUeZdVWWfkBIu5FhjoomK5KDcwLehtV4UkGwmhgUV/nI6Epwj
8D+3UHlmvZxitTkbMI4cqk6pv8lr7nIACAy0EiwvddqrZ9ErPyblyxzMhQIDAQAB
o1MwUTAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDAYDVR0T
AQH/BAIwADAcBgNVHREEFTATghF3d3cubWljcm9zb2Z0LmNvbTANBgkqhkiG9w0B
AQsFAAOCAQEASTWLyx6bifrCHdb1W+Sy011VBqBi2eMVlE6f0bVioyx+bUEezU7p
i0I885alg+PH23cOwcABN3Gn29dd/txRBAlhp4/d02WeT0S+KDiI3k0yHvSS9nSQ
TbhrHMuzEv3MeDs+1+WCZtkRrpwa5lzpn2h0OGrqKNNavSD78uaGDO0XaiMeGwXp
U8+SBBt3wq5UacqABwjpiwhYza+E9eddUwhCHToVlT+74/5s1wlrQx7P0nyQuj9v
4h/YhZ8GzbVHjF29S00lf2T0Rq5rSMaFJA6BQ4y7zjosAM0UnFj1YHwt+pjV1U6t
a+S+AR5JMTw15uUH8h/A2GK05LgdtS9ctw==
-----END CERTIFICATE-----`.split('\n')
};

/**
 * Строит аутбаунд по профилю. Профили двух видов: новый VLESS (есть uuid) и старые
 * shadowsocks-ключи, которые пользователь мог добавить сам через ss:// — их ломать
 * нельзя, поэтому обе формы живут рядом.
 */
function buildOutbound(profile, serverAddress) {
  if (profile.uuid) {
    return {
      type: 'vless',
      tag: 'proxy',
      server: serverAddress,
      server_port: parseInt(profile.port || DEFAULT_SERVER.port, 10),
      uuid: profile.uuid,
      tls: {
        enabled: true,
        // Имя сайта прикрытия, а не адрес нашего сервера. Именно оно уходит открытым
        // текстом в TLS-приветствии и именно его читает DPI.
        server_name: profile.sni || DEFAULT_SERVER.sni,
        // Без uTLS отпечаток рукопожатия выдаёт нестандартный клиент, а это и есть
        // то, по чему фильтруют. С ним соединение выглядит как из Chrome.
        utls: { enabled: true, fingerprint: 'chrome' },
        // Закреплённый сертификат вместо доверия системным центрам: он самоподписанный,
        // но клиент принимает ровно его, поэтому подменить сервер по дороге нельзя.
        certificate: profile.cert || DEFAULT_SERVER.cert
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
        address: ["172.19.0.1/30"],
        mtu: 9000,
        auto_route: true,
        // strict_route: false — если SS сервер недоступен, трафик идёт напрямую
        // (с true весь интернет ломается при любой проблеме с SS)
        strict_route: false,
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
      buildOutbound(effective, serverIps[0] || server),
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