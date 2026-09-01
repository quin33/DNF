@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TAVERN_LOAD_ENV=1"
set "CONTROL_PANEL_PORT=8791"
set "CONTROL_PANEL_STATUS="
for /f %%S in ('curl.exe -s -o nul -w "%%{http_code}" http://127.0.0.1:8791/api/control/health 2^>nul') do set "CONTROL_PANEL_STATUS=%%S"
if "%CONTROL_PANEL_STATUS%"=="200" (
  echo 本机服务控制台已经在 8791 端口运行。
  start "" "http://127.0.0.1:8791"
  exit /b 0
)
title DNF · 本机服务控制台
echo ==========================================
echo   DNF · 本机服务控制台
echo ==========================================
echo 控制台地址：http://127.0.0.1:8791
echo 提示：请先在 .env 中设置 CONTROL_PANEL_PASSWORD。
echo.
start "DNF Control Panel" /min cmd /c "node control-panel.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8791"
