const net = require('net');
const dns = require('dns').promises;

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
  const server = profile.server || 'hayabusa.proxy.rlwy.net';
  const port = parseInt(profile.port || 43081, 10);
  const cipher = profile.cipher || 'aes-256-gcm';
  const password = profile.password || 'gR45-lDTr-9oPq-zXlc';

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
      level: "info",
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
      {
        type: "shadowsocks",
        tag: "proxy",
        server: server,
        server_port: port,
        method: cipher,
        password: password
      },
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
  parseSSUrl,
  generateSingBoxConfig
};