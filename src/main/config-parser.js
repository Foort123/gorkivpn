const net = require('net');
const dns = require('dns').promises;
const https = require('https');
const http = require('http');

// Единственный источник правды по серверу по умолчанию.
const DEFAULT_SERVER = {
  server: 'altaria.proxy.rlwy.net',
  port: 15525,
  cipher: 'aes-256-gcm',
  password: 'nkpbu-irWFX-snzju-M5WQr-zqQr6'
};

const DEFAULT_SUB_URL = 'https://gorkihor-sudo.github.io/vpn-sub/sub.txt';

/**
 * Universal proxy URL parser: parses ss://, vless://, vmess://, trojan://
 */
function parseProxyUrl(line) {
  if (!line || typeof line !== 'string') return null;
  line = line.trim();

  try {
    if (line.startsWith('ss://')) {
      let cleanUrl = line;
      let tag = 'Shadowsocks Server';
      if (cleanUrl.includes('#')) {
        const parts = cleanUrl.split('#');
        cleanUrl = parts[0];
        tag = decodeURIComponent(parts[1]) || tag;
      }
      const body = cleanUrl.replace('ss://', '');
      if (body.includes('@')) {
        const [userinfoB64, hostPort] = body.split('@');
        const decodedUserinfo = Buffer.from(userinfoB64, 'base64').toString('utf-8');
        const [method, password] = decodedUserinfo.split(':');
        const [server, portStr] = hostPort.split(':');
        return {
          protocol: 'shadowsocks',
          name: tag,
          server,
          port: parseInt(portStr, 10),
          cipher: method,
          password
        };
      } else {
        const decoded = Buffer.from(body, 'base64').toString('utf-8');
        const match = decoded.match(/^([^:]+):([^@]+)@([^:]+):(\d+)$/);
        if (match) {
          return {
            protocol: 'shadowsocks',
            name: tag,
            server: match[3],
            port: parseInt(match[4], 10),
            cipher: match[1],
            password: match[2]
          };
        }
      }
    } else if (line.startsWith('vless://')) {
      const url = new URL(line);
      const tag = decodeURIComponent(url.hash.replace('#', '')) || 'VLESS Server';
      const params = url.searchParams;
      return {
        protocol: 'vless',
        name: tag,
        server: url.hostname,
        port: parseInt(url.port || '443', 10),
        uuid: url.username,
        flow: params.get('flow') || undefined,
        tls: params.get('security') === 'tls' || params.get('security') === 'reality',
        sni: params.get('sni') || url.hostname,
        reality: params.get('security') === 'reality' ? {
          public_key: params.get('pbk'),
          short_id: params.get('sid')
        } : undefined,
        transport: params.get('type') === 'ws' ? {
          type: 'ws',
          path: params.get('path') || '/',
          headers: params.get('host') ? { Host: params.get('host') } : undefined
        } : undefined
      };
    } else if (line.startsWith('vmess://')) {
      const b64 = line.replace('vmess://', '');
      const jsonStr = Buffer.from(b64, 'base64').toString('utf-8');
      const data = JSON.parse(jsonStr);
      return {
        protocol: 'vmess',
        name: data.ps || 'VMess Server',
        server: data.add,
        port: parseInt(data.port, 10),
        uuid: data.id,
        cipher: data.scy || 'auto',
        alterId: parseInt(data.aid || '0', 10),
        tls: data.tls === 'tls',
        sni: data.sni || data.host || data.add,
        transport: data.net === 'ws' ? {
          type: 'ws',
          path: data.path || '/',
          headers: data.host ? { Host: data.host } : undefined
        } : undefined
      };
    } else if (line.startsWith('trojan://')) {
      const url = new URL(line);
      const tag = decodeURIComponent(url.hash.replace('#', '')) || 'Trojan Server';
      const params = url.searchParams;
      return {
        protocol: 'trojan',
        name: tag,
        server: url.hostname,
        port: parseInt(url.port || '443', 10),
        password: url.username,
        tls: true,
        sni: params.get('sni') || url.hostname,
        transport: params.get('type') === 'ws' ? {
          type: 'ws',
          path: params.get('path') || '/',
          headers: (params.get('host') || params.get('Host')) ? { Host: params.get('host') || params.get('Host') } : undefined
        } : undefined
      };
    }
  } catch (err) {
    console.error('Error parsing proxy URL:', line.slice(0, 30), err.message);
  }
  return null;
}

/**
 * Parses an ss:// URI (legacy alias for backward compatibility)
 */
function parseSSUrl(ssUrl) {
  return parseProxyUrl(ssUrl);
}

/**
 * Downloads URL content with redirect support
 */
function fetchUrl(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'v2rayNG/1.8.5 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*'
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location, timeoutMs));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }
      let rawData = '';
      res.on('data', chunk => rawData += chunk);
      res.on('end', () => resolve(rawData));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
    req.on('error', reject);
  });
}

/**
 * Fetches and parses a subscription URL (Base64 or plaintext lines)
 */
async function fetchSubscription(subUrl = DEFAULT_SUB_URL) {
  let content = '';
  try {
    content = await fetchUrl(subUrl);
  } catch (err) {
    // If GitHub Pages is unreachable, try raw github fallback
    if (subUrl.includes('gorkihor-sudo.github.io')) {
      const fallback = 'https://raw.githubusercontent.com/gorkihor-sudo/vpn-sub/main/sub.txt';
      console.log('Trying fallback subscription URL:', fallback);
      content = await fetchUrl(fallback);
    } else {
      throw err;
    }
  }

  content = content.trim();
  let lines = [];
  try {
    const decoded = Buffer.from(content, 'base64').toString('utf-8');
    if (decoded.includes('://')) {
      lines = decoded.split(/\r?\n/);
    } else {
      lines = content.split(/\r?\n/);
    }
  } catch (e) {
    lines = content.split(/\r?\n/);
  }

  const profiles = [];
  let index = 1;
  for (const line of lines) {
    const parsed = parseProxyUrl(line);
    if (parsed && parsed.server) {
      profiles.push({
        id: `gh-sub-${Date.now()}-${index++}`,
        ...parsed,
        isSubscription: true
      });
    }
  }

  return profiles;
}

/**
 * Generates sing-box JSON config object (schema: sing-box 1.13+)
 * Supports Shadowsocks, VLESS, VMess, and Trojan outbounds
 */
async function generateSingBoxConfig(profile, excluded = []) {
  const protocol = (profile.protocol || profile.type || 'shadowsocks').toLowerCase();
  const server = profile.server || DEFAULT_SERVER.server;
  const port = parseInt(profile.port || DEFAULT_SERVER.port, 10);
  const bypass = excluded.filter(e => e && e.exe).map(e => e.exe);

  let serverIps = [];
  try {
    serverIps = net.isIP(server) ? [server] : await dns.resolve4(server);
  } catch (e) {
    console.error('Не удалось резолвить адрес сервера для direct-правила:', e.message);
  }

  // Construct sing-box outbound based on protocol
  let proxyOutbound = null;

  if (protocol === 'vless') {
    proxyOutbound = {
      type: 'vless',
      tag: 'proxy',
      server: serverIps[0] || server,
      server_port: port,
      uuid: profile.uuid || profile.password || 'de305d54-75b3-431b-a0ce-b8724def4f6b'
    };
    if (profile.flow) {
      proxyOutbound.flow = profile.flow;
    }
    if (profile.tls) {
      proxyOutbound.tls = {
        enabled: true,
        server_name: profile.sni || server,
        insecure: true
      };
      if (profile.reality) {
        proxyOutbound.tls.reality = {
          enabled: true,
          public_key: profile.reality.public_key,
          short_id: profile.reality.short_id || ''
        };
      }
    }
    if (profile.transport) {
      proxyOutbound.transport = profile.transport;
    }
  } else if (protocol === 'vmess') {
    proxyOutbound = {
      type: 'vmess',
      tag: 'proxy',
      server: serverIps[0] || server,
      server_port: port,
      uuid: profile.uuid || profile.password,
      security: profile.cipher || 'auto',
      alter_id: profile.alterId || 0
    };
    if (profile.tls) {
      proxyOutbound.tls = {
        enabled: true,
        server_name: profile.sni || server,
        insecure: true
      };
    }
    if (profile.transport) {
      proxyOutbound.transport = profile.transport;
    }
  } else if (protocol === 'trojan') {
    proxyOutbound = {
      type: 'trojan',
      tag: 'proxy',
      server: serverIps[0] || server,
      server_port: port,
      password: profile.password,
      tls: {
        enabled: true,
        server_name: profile.sni || server,
        insecure: true
      }
    };
    if (profile.transport) {
      proxyOutbound.transport = profile.transport;
    }
  } else {
    // Default: Shadowsocks
    proxyOutbound = {
      type: 'shadowsocks',
      tag: 'proxy',
      server: serverIps[0] || server,
      server_port: port,
      method: profile.cipher || DEFAULT_SERVER.cipher,
      password: profile.password || DEFAULT_SERVER.password
    };
  }

  return {
    log: {
      level: "trace",
      timestamp: true
    },
    dns: {
      servers: [
        { tag: "remote", type: "https", server: "1.1.1.1", detour: "proxy" },
        { tag: "local", type: "local" }
      ],
      rules: [
        { domain: [server], server: "local" },
        ...(bypass.length ? [{ process_name: bypass, server: "local" }] : []),
        { query_type: ["A", "AAAA"], server: "remote", strategy: "ipv4_only" }
      ],
      final: "local"
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        address: ["172.19.0.1/30"],
        mtu: 9000,
        auto_route: true,
        strict_route: false,
        ...(serverIps.length ? { route_exclude_address: serverIps.map(ip => `${ip}/32`) } : {}),
        stack: "mixed"
      }
    ],
    outbounds: [
      proxyOutbound,
      {
        type: "direct",
        tag: "direct"
      }
    ],
    route: {
      auto_detect_interface: true,
      default_domain_resolver: { server: "local", strategy: "ipv4_only" },
      final: "proxy",
      rules: [
        ...(serverIps.length ? [{ ip_cidr: serverIps, outbound: "direct" }] : []),
        { port: 53, action: "hijack-dns" },
        { ip_is_private: true, outbound: "direct" },
        ...(bypass.length ? [{ process_name: bypass, outbound: "direct" }] : []),
        { network: "udp", port: 443, action: "reject" }
      ]
    },
    experimental: {
      clash_api: {
        external_controller: "127.0.0.1:9090",
        access_control_allow_origin: ["*"]
      }
    }
  };
}

module.exports = {
  DEFAULT_SERVER,
  DEFAULT_SUB_URL,
  parseSSUrl,
  parseProxyUrl,
  fetchSubscription,
  generateSingBoxConfig
};