const { generateSingBoxConfig } = require('./src/main/config-parser');

(async () => {
    const config = await generateSingBoxConfig({
        server: 'trolley.proxy.rlwy.net',
        port: 26350,
        cipher: 'aes-256-gcm',
        password: 'gR45-lDTr-9oPq-zXlc'
    });
    console.log(JSON.stringify(config, null, 2));
})();