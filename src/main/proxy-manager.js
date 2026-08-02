const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

class ProxyManager {
  constructor(appDir, binDir = path.join(appDir, 'bin')) {
    this.appDir = appDir;
    this.binPath = path.join(binDir, 'sing-box.exe');
    // конфиг для sing-box нельзя писать в resources/app.asar (read-only архив) —
    // пишем в appDir (userData), бинарь читает его по абсолютному пути
    this.configPath = path.join(appDir, 'current_config.json');
    // Лог sing-box на диск: без него на чужой машине "не работает" нечем объяснить
    this.logPath = path.join(appDir, 'singbox.log');
    this.childProcess = null;
    this.isConnected = false;
    this.currentProfile = null;
    this.localPort = 10808;
    this.bytesUploaded = 0;
    this.bytesDownloaded = 0;
    this.logBytes = 0;
  }

  setSystemProxy(enable, port = 10808) {
    // TUN режим не использует системный прокси - просто возвращаем true
    return Promise.resolve(true);
  }

  async start(configObj, profile) {
    if (this.childProcess) {
      await this.stop();
    }

    this.currentProfile = profile;
    fs.writeFileSync(this.configPath, JSON.stringify(configObj, null, 2), 'utf-8');
    // перезаписываем, а не дописываем: в логе всегда только последняя попытка
    try { fs.writeFileSync(this.logPath, ''); } catch (e) { /* лог не критичен */ }
    this.logBytes = 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      let lastError = '';
      let giveUp = null;
      try {
        console.log('Spawning sing-box process from:', this.binPath);
        this.childProcess = spawn(this.binPath, ['run', '-c', this.configPath], {
          cwd: this.appDir,
          windowsHide: true
        });

        const fail = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(giveUp);
          this.isConnected = false;
          reject(err);
        };

        const onLog = (data) => {
          const log = data.toString();
          console.log('[sing-box]', log);
          // ponytail: жёсткий потолок 5 МБ без ротации — лог и так перезаписывается при старте.
          // appendFileSync синхронный и живёт в main-процессе: при петле маршрутизации
          // это 91 МБ за минуту и намертво залипший UI.
          if (this.logBytes < 5 * 1024 * 1024) {
            try {
              fs.appendFileSync(this.logPath, log);
              this.logBytes += Buffer.byteLength(log);
            } catch (e) { /* лог не критичен */ }
          }
          // sing-box печатает FATAL и продолжает умирать асинхронно - без этого
          // старт "успешно" резолвился, а туннеля не было
          if (/FATAL|panic:/.test(log)) { lastError = log.trim(); fail(new Error(lastError)); }
          if (/ERROR/.test(log)) lastError = log.trim();
          // Единственный честный признак готовности. Раньше тут стоял таймер на 2.5с:
          // на медленной машине (установка драйвера wintun, создание TUN) он срабатывал
          // раньше старта, приложение писало "подключено", а туннеля не было — и весь
          // трафик, включая замер пинга, отваливался по таймауту.
          if (/sing-box started/.test(log) && !settled) {
            settled = true;
            clearTimeout(giveUp);
            this.isConnected = true;
            // TUN инбаунд сам настраивает маршруты (auto_route), системный прокси не нужен
            resolve({ success: true, profile: this.currentProfile });
          }
        };

        this.childProcess.stdout.on('data', onLog);
        this.childProcess.stderr.on('data', onLog);

        this.childProcess.on('error', (err) => {
          console.error('sing-box process error:', err);
          fail(err);
        });

        this.childProcess.on('exit', (code, signal) => {
          console.log(`sing-box exited with code ${code}, signal ${signal}`);
          this.isConnected = false;
          this.childProcess = null;
          // TUN автоматически очищает маршруты при остановке
          fail(new Error(lastError || `sing-box завершился с кодом ${code}. Лог: ${this.logPath}`));
        });

        // Установка драйвера wintun на чистой машине занимает до десятка секунд
        giveUp = setTimeout(() => {
          fail(new Error(`sing-box не запустился за 30 с. Лог: ${this.logPath}`));
          this.stop();
        }, 30000);

      } catch (err) {
        console.error('Failed to start proxy manager:', err);
        reject(err);
      }
    });
  }

  async stop() {
    this.isConnected = false;

    const child = this.childProcess;
    if (!child) return { success: true };
    this.childProcess = null;

    // Ждём реального выхода: иначе реконнект упрётся в ещё живой TUN-адаптер и порт 9090.
    // Подстраховка бьёт по PID и снимается при штатном выходе — раньше она висела в очереди
    // и через секунду убивала по имени уже НОВЫЙ sing-box, поднятый применением исключений.
    await new Promise((resolve) => {
      const fallback = setTimeout(
        () => exec(`taskkill /F /T /PID ${child.pid}`, () => resolve()),
        1000
      );
      child.once('exit', () => { clearTimeout(fallback); resolve(); });
      try {
        child.kill('SIGKILL');
      } catch (e) {
        console.error('Error killing child process:', e);
      }
    });

    return { success: true };
  }

  async pingServer(host, port, timeout = 3000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = new net.Socket();

      socket.setTimeout(timeout);

      socket.on('connect', () => {
        const duration = Date.now() - start;
        socket.destroy();
        resolve(duration);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(-1);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(-1);
      });

      socket.connect(port, host);
    });
  }
}

module.exports = ProxyManager;
