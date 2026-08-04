@echo off
setlocal
set "CSC="
for /d %%d in (%WINDIR%\Microsoft.NET\Framework\v4.*) do (
    if exist "%%d\csc.exe" set "CSC=%%d\csc.exe"
)
if not defined CSC (
    for /d %%d in (%WINDIR%\Microsoft.NET\Framework64\v4.*) do (
        if exist "%%d\csc.exe" set "CSC=%%d\csc.exe"
    )
)

if not defined CSC (
    echo csc.exe not found! Make sure .NET Framework 4.x is installed.
    exit /b 1
)

echo Compiling loader.cs using "%CSC%"...
"%CSC%" /target:winexe /win32icon:GORKIVPN.ico /r:System.IO.Compression.FileSystem.dll /out:GORKIVPN-loader.exe loader.cs
if %ERRORLEVEL% neq 0 (
    echo Compilation failed.
    exit /b %ERRORLEVEL%
)

echo Success! GORKIVPN-loader.exe is now a single, self-contained executable.
