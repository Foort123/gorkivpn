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
  const server = profile.server || 'trolley.proxy.rlwy.net';
  const port = parseInt(profile.port || 26350, 10);
  const cipher = profile.cipher || 'aes-256-gcm';
  const password = profile.password || 'gR45-lDTr-9oPq-zXlc';

  const bypass = excluded.filter(e => e && e.exe).map(e => e.exe);

  return {
    log: {
      level: "info",
      timestamp: true
    },
    dns: {
      servers: [
        // DoT через прокси: TCP-based, работает даже если UDP-relay на сервере сломан
        { tag: "remote", type: "tls", server: "1.1.1.1", detour: "proxy" },
        // резолвит только домен самого VPN-сервера; без detour запрос идёт напрямую,
        // мимо route (detour: "direct" тут — FATAL "empty direct outbound makes no sense")
        { tag: "local", type: "udp", server: "8.8.8.8" }
      ],
      rules: [
        { domain: [server], server: "local" },
        // исключённые резолвят локально, иначе получат чужую гео-выдачу CDN
        ...(bypass.length ? [{ process_name: bypass, server: "local" }] : []),
        // ipv4_only: у TUN нет IPv6-адреса, AAAA-ответы дали бы висящие коннекты
        { query_type: ["A", "AAAA"], server: "remote", strategy: "ipv4_only" }
      ],
      final: "remote"
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        address: ["172.19.0.1/30"],
        mtu: 9000,
        auto_route: true,
        strict_route: true,
        stack: "gvisor"
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
      // обязателен с 1.12: сервер SS-outbound'а задан доменом, его надо кем-то резолвить
      default_domain_resolver: { server: "local" },
      final: "proxy",
      rules: [
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