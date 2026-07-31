const { exec } = require('child_process');
const path = require('path');

// Оболочки Windows: окна у них есть, но исключать их бессмысленно
const SYSTEM_SHELLS = new Set([
  'ApplicationFrameHost.exe', 'TextInputHost.exe', 'ShellExperienceHost.exe',
  'StartMenuExperienceHost.exe', 'SearchHost.exe', 'SystemSettings.exe'
]);

// OutputEncoding обязателен: без него кириллица в заголовках окон приезжает как "?????".
// HasWindow (а не заголовок) отделяет приложения от фона - так же, как диспетчер задач.
const PS_COMMAND =
  'powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
  " Get-Process | Select-Object Name,Path,Description," +
  " @{n='HasWindow';e={$_.MainWindowHandle -ne 0}} | ConvertTo-Json -Compress\"";

/** Схлопывает процессы в список уникальных exe: приложения с окном сверху, фон ниже */
function groupProcesses(list) {
  const byExe = new Map();

  for (const p of list) {
    const exe = p.Path ? path.basename(p.Path) : `${p.Name}.exe`;
    if (SYSTEM_SHELLS.has(exe)) continue;

    const prev = byExe.get(exe);
    if (!prev) {
      // Description - это то самое читаемое имя, что показывает диспетчер задач
      byExe.set(exe, { exe, label: p.Description || p.Name, app: !!p.HasWindow, count: 1 });
    } else {
      prev.count++;
      prev.app = prev.app || !!p.HasWindow;
      if (!prev.label) prev.label = p.Description || p.Name;
    }
  }

  return [...byExe.values()].sort((a, b) =>
    (b.app ? 1 : 0) - (a.app ? 1 : 0) || a.label.localeCompare(b.label)
  );
}

function listProcesses() {
  return new Promise((resolve) => {
    exec(PS_COMMAND, { maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        resolve(groupProcesses(JSON.parse(stdout)));
      } catch (e) {
        resolve([]);
      }
    });
  });
}

module.exports = { listProcesses, groupProcesses };
