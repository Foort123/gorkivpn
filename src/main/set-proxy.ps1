param(
    [int]$Enable = 0,
    [string]$Server = "127.0.0.1:10808"
)

if ($Enable -eq 1) {
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable -Value 1 -Type DWord
     # Use format "socks=127.0.0.1:10808" for SOCKS5 proxy (forces all traffic through proxy including DNS)
     Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyServer -Value "socks=$Server" -Type String
} else {
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable -Value 0 -Type DWord
    # Clear proxy server when disabling
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyServer -ErrorAction SilentlyContinue
}

$typeDefinition = @"
using System;
using System.Runtime.InteropServices;

public class WinInet {
    [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
"@

try {
    Add-Type -TypeDefinition $typeDefinition -ErrorAction SilentlyContinue
    [WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
    [WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
} catch {
}
