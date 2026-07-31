const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

class ProxyManager {
  constructor(appDir, binDir = path.join(appDir, 'bin')) {
    this.appDir = appDir;
    this.binPath = path.join(binDir, 'sing-box.exe');
    // конфиг для sing-box нельзя писать в resources/app.asar (read-only архив) —
    // пишем в userData, бинарь читает его по абсолютному пути
    this.configPath = path.join(require('electron').app.getPath('userData'), 'current_config.json');
    this.childProcess = null;
    this.isConnected = false;
    this.currentProfile = null;
    this.localPort = 10808;
    this.bytesUploaded = 0;
    this.bytesDownloaded = 0;
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

    return new Promise((resolve, reject) => {
      try {
        console.log('Spawning sing-box process from:', this.binPath);
        this.childProcess = spawn(this.binPath, ['run', '-c', this.configPath], {
          cwd: this.appDir,
          windowsHide: true
        });

        let settled = false;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          this.isConnected = false;
          reject(err);
        };

        const onLog = (data) => {
          const log = data.toString();
          console.log('[sing-box]', log);
          // sing-box печатает FATAL и продолжает умирать асинхронно - без этого
          // старт "успешно" резолвился, а туннеля не было
          if (/FATAL|panic:/.test(log)) fail(new Error(log.trim()));
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
          fail(new Error(`sing-box exited with code ${code} (TUN требует прав администратора)`));
        });

        // Создание TUN-интерфейса на Windows занимает секунду-другую
        setTimeout(() => {
          if (settled) return;
          settled = true;
          this.isConnected = true;
          // TUN инбаунд сам настраивает маршруты (auto_route), системный прокси не нужен
          resolve({ success: true, profile: this.currentProfile });
        }, 2500);

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

    // Ждём реального выхода: иначе реконнект упрётся в ещё живой TUN-адаптер и порт 9090
    await new Promise((resolve) => {
      child.once('exit', resolve);
      try {
        child.kill('SIGKILL');
      } catch (e) {
        console.error('Error killing child process:', e);
      }
      setTimeout(() => exec('taskkill /F /IM sing-box.exe', () => resolve()), 1000);
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
