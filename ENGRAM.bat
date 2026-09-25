@echo off
rem ENGRAM - start the tray. Deliberate on purpose: every step says what
rem it is doing and stops on the first thing that is wrong.
rem   1. Node must exist (the tray shell and the installer build need it).
rem   2. The tray's one dependency (Electron) is installed if missing.
rem   3. The tray starts detached: it survives this window closing and
rem      quits only from its own menu. It owns the local server on the
rem      registered port (tools\launch.config.json); Ctrl+Space opens
rem      the Recall palette from anywhere.
rem An installed Engram (the setup exe) does not use this file.
title Engram
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%PATH%"
    ) else (
        echo  STOP: node.exe was not found. Install Node from https://nodejs.org and run this again.
        pause
        exit /b 1
    )
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo  First run: installing the tray shell ^(Electron^). This downloads once and takes a minute.
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo  STOP: npm install failed. Read the lines above.
        pause
        exit /b 1
    )
)

if not exist "assets\states\idle.png" (
    echo  Drawing the icons...
    node tools\make-icon.mjs
)

echo  Starting Engram in the system tray. Ctrl+Space opens Recall. Quit from the tray menu.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
