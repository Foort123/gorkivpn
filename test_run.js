const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const dnsp = require('dns').promises;
const net = require('net');
const { DEFAULT_SERVER, buildOutbound } = require('./src/main/config-parser');

const binPath = path.join(__dirname, 'bin', 'sing-box.exe');
const configPath = path.join(__dirname, 'test_run_config.json');
const fs = require('fs');

let child;

(async () => {
// Резолвим средствами Node — ровно как боевой config-parser. Внутренний резолвер
// sing-box ("local") отвечает не на каждой машине, и тест падал бы на DNS, а не на
// том, что проверяет: доходит ли Shadowsocks-хендшейк до сервера.
const serverIp = net.isIP(DEFAULT_SERVER.server)
    ? DEFAULT_SERVER.server
    : (await dnsp.resolve4(DEFAULT_SERVER.server))[0];
console.log(`Сервер: ${DEFAULT_SERVER.server} -> ${serverIp}:${DEFAULT_SERVER.port}`);

const configObj = {
    log: { level: 'info', timestamp: true },
    inbounds: [{
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 10808
    }],
    outbounds: [buildOutbound(DEFAULT_SERVER, serverIp), {
        type: 'direct',
        tag: 'direct'
    }]
};

fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2));

console.log('Spawning sing-box...');

child = spawn(binPath, ['run', '-c', configPath], {
    cwd: __dirname,
    windowsHide: true
});

child.stderr.on('data', (data) => console.log('[sing-box]', data.toString()));

setTimeout(() => {
    console.log('Testing proxy...');

    // Test through proxy
    const options = {
        hostname: '127.0.0.1',
        port: 10808,
        path: 'https://api.ipify.org',
        method: 'GET',
        headers: {
            'Connection': 'close'
        }
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            console.log('IP через прокси (mixed):', data.trim());

            // Also test with curl for comparison
            const { exec } = require('child_process');
            exec('curl -s -x http://127.0.0.1:10808 https://api.ipify.org', (err, stdout, stderr) => {
                console.log('IP через curl:', stdout.trim());
                cleanup();
            });
        });
    });

    req.on('error', (e) => {
        console.log('HTTP error:', e.message);
        cleanup();
    });
    req.end();

    function cleanup() {
        setTimeout(() => {
            child.kill();
            fs.unlinkSync(configPath);
            console.log('Done');
        }, 1000);
    }
}, 2000);
})();