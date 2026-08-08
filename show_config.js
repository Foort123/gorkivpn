const { generateSingBoxConfig } = require('./src/main/config-parser');

(async () => {
    // без профиля — подставятся DEFAULT_SERVER из config-parser
    const config = await generateSingBoxConfig({});
    console.log(JSON.stringify(config, null, 2));
})();
