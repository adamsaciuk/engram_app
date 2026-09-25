@echo off
rem STOP ENGRAM - stops the local server on the registered port through
rem its own /__stop, never by killing a pid. The tray sees its server go
rem and, if it started it, exits with it; a tray that reused a server
rem started elsewhere restarts one within 15 s, so quit the tray from its
rem menu when you mean to stop everything.
title STOP ENGRAM
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo  STOP: node.exe was not found on PATH.
    pause
    exit /b 1
)
node "%~dp0server\server.mjs" --stop
if errorlevel 1 (
    pause
) else (
    timeout /t 2 /nobreak >nul
)
exit /b 0
