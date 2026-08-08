const net = require('net');
const dns = require('dns').promises;

// Единственный источник правды по серверу по умолчанию. Раньше эти значения лежали
// копиями в index.js, config-parser.js и трёх отладочных скриптах — при каждом
// переезде часть копий забывали, и клиент шёл на снесённый хост со старым паролем.
//
// VMess поверх WebSocket без TLS. Это не первый выбор, а единственный уцелевший —
// остальное отсекла фильтрация на пути (провайдер в России, ТСПУ):
//
// 1. Голый shadowsocks через TCP Proxy глушится: сервер и ключ исправны (клиент
//    внутри дата-центра Railway ходил через них успешно), но с домашней машины
//    трафик приходит испорченным. DPI узнаёт рукопожатие по случайным первым байтам.
// 2. HTTP-вход Railway 69.46.46.8 заблокирован по адресу целиком.
// 3. Любое TLS-рукопожатие на вход TCP Proxy 66.33.22.220 глушится — проверено на
//    SNI www.microsoft.com, altaria.proxy.rlwy.net и github.com, результат один.
// 4. REALITY не работает между двумя sing-box: SagerNet/sing-box#4023, воспроизведено
//    локально на свежих ключах и всех отпечатках uTLS.
//
// А обычный HTTP на тот же адрес проходит: посланный вручную GET дошёл до сервера и
// был отвергнут за 161 мс. Отсюда WebSocket без TLS — соединение открывается рядовым
// GET с Upgrade, низкая энтропия, распознавать нечего. Содержимое шифрует сам VMess,
// так что трафик закрыт; не закрыт лишь факт использования прокси, но при заглушенном
// TLS выбора нет.
const DEFAULT_SERVER = {
  server: 'altaria.proxy.rlwy.net',
  port: 15525,
  uuid: '43698ce4-7cf4-432d-8938-1b7b908d5a1c',
  wsPath: '/3ee2889cb2'
};

/**
 * Строит аутбаунд по профилю. Профили двух видов: наш VMess (есть uuid) и старые
 * shadowsocks-ключи, которые пользователь мог добавить сам через ss:// — их ломать
 * нельзя, поэтому обе формы живут рядом.
 */
function buildOutbound(profile, serverAddress) {
  if (profile.uuid) {
    return {
      type: 'vmess',
      tag: 'proxy',
      server: serverAddress,
      server_port: parseInt(profile.port || DEFAULT_SERVER.port, 10),
      uuid: profile.uuid,
      // Шифрование содержимого берёт на себя VMess: TLS тут нет, и без этого трафик
      // шёл бы открытым текстом.
      security: 'aes-128-gcm',
      // WebSocket без TLS. Соединение открывается обычным GET с Upgrade — низкая
      // энтропия, снаружи неотличимо от рядового веб-сокета. Именно это и проходит
      // там, где TLS-рукопожатие глушится целиком.
      transport: {
        type: 'ws',
        path: profile.wsPath || DEFAULT_SERVER.wsPath
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