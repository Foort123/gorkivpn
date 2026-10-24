const fs = require('fs');
const { spawn } = require('child_process');
const { DEFAULT_SERVER, buildOutbound } = require('./src/main/config-parser');

const config = {
    log: { level: "trace" },
    inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 10808 }],
    outbounds: [
        buildOutbound(DEFAULT_SERVER, DEFAULT_SERVER.server),
        { type: "direct", tag: "direct" },
        { type: "block", tag: "block" }
    ],
    route: { rules: [{ ip_is_private: true, outbound: "direct" }], auto_detect_interface: true }
};

fs.writeFileSync('test_config.json', JSON.stringify(config, null, 2));
console.log('Config saved');

const child = spawn('bin\\sing-box.exe', ['check', '-c', 'test_config.json'], { cwd: __dirname, stdio: 'inherit' });

child.on('close', (code) => {
    console.log('Exit code:', code);
    fs.unlinkSync('test_config.json');
});