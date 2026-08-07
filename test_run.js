const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const configObj = {
    log: { level: 'info', timestamp: true },
    inbounds: [{
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 10808
    }],
    outbounds: [{
        type: 'shadowsocks',
        tag: 'proxy',
        server: 'hayabusa.proxy.rlwy.net',
        server_port: 43081,
        method: 'aes-256-gcm',
        password: 'gR45-lDTr-9oPq-zXlc'
    }, {
        type: 'direct',
        tag: 'direct'
    }]
};

const configPath = path.join(__dirname, 'test_run_config.json');
const fs = require('fs');
fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2));

const binPath = path.join(__dirname, 'bin', 'sing-box.exe');
console.log('Spawning sing-box...');

const child = spawn(binPath, ['run', '-c', configPath], {
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