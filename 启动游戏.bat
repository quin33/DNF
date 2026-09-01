@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TAVERN_LOAD_ENV=1"
set "GAME_HTTP_STATUS="
for /f %%S in ('curl.exe -s -o nul -w "%%{http_code}" http://127.0.0.1:8788/ 2^>nul') do set "GAME_HTTP_STATUS=%%S"
if "%GAME_HTTP_STATUS%"=="200" (
  echo 游戏服务已经在 8788 端口运行，无需重复启动。
  start "" "http://127.0.0.1:8788"
  pause
  exit /b 0
)
set "GAME_PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8788 .*LISTENING"') do set "GAME_PORT_PID=%%P"
if not "%GAME_PORT_PID%"=="" (
  echo 8788 端口已被其他程序占用，游戏服务未启动。
  echo 占用进程 PID：%GAME_PORT_PID%
  pause
  exit /b 1
)
title DNF · AI 探险日志服务
echo ==========================================
echo   DNF · AI 探险日志服务
echo ==========================================
echo.
node server.js
pause
