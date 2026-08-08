# GORKIVPN: сбор диагностики с чужой машины в один файл.
# Запуск (обычный PowerShell, права админа не нужны):
#   powershell -ExecutionPolicy Bypass -File collect-diag.ps1
# Результат: на Рабочем столе gorkivpn-diag.txt — его и прислать.

$ErrorActionPreference = 'Continue'
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'gorkivpn-diag.txt'
$L = [System.Collections.Generic.List[string]]::new()
function Add($s) { $L.Add([string]$s) }

# app.asar сборки, залитой в релиз 2026-08-02 (v2) — если хеш другой, обновление не доехало
$GOOD_ASAR = 'b7c53cc7143207c4e3f22af42bfb82fe5bc6fbab38bbd2dc5c4cb274edc62c73'

Add "=== GORKIVPN diag $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
Add "Windows      : $([Environment]::OSVersion.VersionString)"
Add "Пользователь : $env:USERNAME"
Add "Админ        : $((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole('Administrator'))"

# --- куда установлено ---
$marker = "$env:LOCALAPPDATA\GORKIVPN\install_path.txt"
$dir = if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { $null }
Add ''
Add "Маркер установки : $marker -> $(if($dir){$dir}else{'НЕТ'})"
if ($dir -and (Test-Path $dir)) {
  $exe = Join-Path $dir 'GORKIVPN.exe'
  $asar = Join-Path $dir 'resources\app.asar'
  $sb   = Join-Path $dir 'resources\app.asar.unpacked\bin\sing-box.exe'
  $wt   = Join-Path $dir 'resources\app.asar.unpacked\bin\wintun.dll'
  foreach ($f in @($exe, $asar, $sb, $wt)) {
    if (Test-Path $f) {
      $i = Get-Item $f
      Add ("  {0,-58} {1,12} Б  {2}" -f $i.Name, $i.Length, $i.LastWriteTime)
    } else {
      Add ("  {0,-58} ОТСУТСТВУЕТ (антивирус?)" -f (Split-Path $f -Leaf))
    }
  }
  if (Test-Path $asar) {
    $h = (Get-FileHash $asar -Algorithm SHA256).Hash.ToLower()
    Add "  app.asar sha256 : $h"
    Add "  СБОРКА          : $(if($h -eq $GOOD_ASAR){'НОВАЯ (фикс петли есть)'}else{'СТАРАЯ — обновление не установилось!'})"
  }
} else {
  Add '  папка установки не найдена'
}

# --- рантайм ---
$ud = "$env:APPDATA\gorkivpn"
Add ''
Add "userData : $ud"
$log = Join-Path $ud 'singbox.log'
if (Test-Path $log) {
  $li = Get-Item $log
  Add "  singbox.log : $($li.Length) Б, изменён $($li.LastWriteTime)"
  # объём лога сам по себе диагноз: петля маршрутизации даёт десятки МБ за минуту
  Add "  ЛОГ         : $(if($li.Length -gt 5MB){'ОГРОМНЫЙ — похоже на петлю'}else{'нормальный'})"
  # сколько раз туннель ловил соединения к самому VPN-серверу (признак петли)
  $cfgFile = Join-Path $ud 'current_config.json'
  if (Test-Path $cfgFile) {
    $srvIp = (Get-Content $cfgFile -Raw | ConvertFrom-Json).route.rules[0].ip_cidr
    if ($srvIp) {
      $loops = (Select-String -Path $log -Pattern "tun-in.*$($srvIp[0])" -AllMatches | Measure-Object).Count
      Add "  строк петли (tun-in -> $($srvIp[0])) : $loops   <- должно быть 0"
    }
  }
} else {
  Add '  singbox.log НЕТ — sing-box ни разу не стартовал'
}

Add ''
Add '--- current_config.json (пароль вырезан) ---'
$cfg = Join-Path $ud 'current_config.json'
if (Test-Path $cfg) {
  Add ((Get-Content $cfg -Raw) -replace '"password":\s*"[^"]*"', '"password": "***"')
} else { Add '  НЕТ — подключения ни разу не было' }

Add ''
Add '--- singbox.log: первые 60 строк ---'
if (Test-Path $log) { Add ((Get-Content $log -TotalCount 60) -join "`n") }

Add ''
Add '--- singbox.log: последние 60 строк ---'
if (Test-Path $log) { Add ((Get-Content $log -Tail 60) -join "`n") }

Add ''
Add '--- сеть ---'
Add ((Get-NetIPConfiguration | Where-Object { $_.NetProfile } |
      Select-Object InterfaceAlias, @{n='IPv4';e={$_.IPv4Address.IPAddress}},
                    @{n='GW';e={$_.IPv4DefaultGateway.NextHop}} |
      Format-Table -AutoSize | Out-String))
Add "TCP до altaria.proxy.rlwy.net:15525 : $((Test-NetConnection altaria.proxy.rlwy.net -Port 15525 -WarningAction SilentlyContinue).TcpTestSucceeded)"

Add ''
Add '--- процессы ---'
Add ((Get-Process GORKIVPN, sing-box -ErrorAction SilentlyContinue |
      Select-Object Name, Id, StartTime | Format-Table -AutoSize | Out-String))

Add ''
Add '--- Защитник: что удалял ---'
try {
  $t = Get-MpThreatDetection -ErrorAction Stop | Sort-Object InitialDetectionTime -Descending | Select-Object -First 10
  if ($t) { Add (($t | Select-Object InitialDetectionTime, ThreatID, @{n='Resources';e={$_.Resources -join ';'}} |
                  Format-Table -AutoSize | Out-String)) } else { Add '  ничего' }
} catch { Add "  недоступно: $($_.Exception.Message)" }

$L -join "`r`n" | Out-File -FilePath $out -Encoding utf8
Write-Host "Готово: $out"
