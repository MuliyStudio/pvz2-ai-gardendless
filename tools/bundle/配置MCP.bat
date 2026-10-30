@echo off
chcp 65001 >nul
title PvZ2 Gardendless - MCP 配置
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0tools\install_mcp_config.mjs" --all
echo.
pause
exit /b 0

:nonode
echo.
echo 没有找到 Node.js。请先安装 Node.js 22 或更新版本，并把 node 加入 PATH。
echo 下载：https://nodejs.org/
echo.
pause
exit /b 1
