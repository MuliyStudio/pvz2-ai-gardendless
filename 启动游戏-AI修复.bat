@echo off
chcp 65001 >nul
title PvZ2 Gardendless - AI Launcher
cd /d "%~dp0"

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if exist "%NODE_EXE%" goto run
where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODE_EXE=node"

:run
echo.
echo  IMPORTANT: close the game completely before running this.
echo  Keep this window open (you can minimize it) while playing with AI.
echo.
"%NODE_EXE%" "%~dp0tools\launch_game_csp_bypass.mjs" %*
echo.
echo Launcher exited. If the game is still running, CSP bypass may be lost.
pause
exit /b 0

:nonode
echo.
echo Node.js not found. Install Node.js or add node to PATH.
pause
exit /b 1
