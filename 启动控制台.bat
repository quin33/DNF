@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "TAVERN_LOAD_ENV=1"
rem 端口在此显式钉死，避免继承同一命令行窗口里其它项目（xiuxian 用 8790/8787）
rem 残留的同名变量。node 侧 .env 只填补未设置的变量，所以这里设了就一定生效。
rem 若要改端口，请同时改本文件、.env 与 cloudflared 的 ingress 配置。
set "CONTROL_PANEL_PORT=8791"
set "GAME_PORT=8788"
set "PORT=8788"
set "CONTROL_PANEL_STATUS="
for /f %%S in ('curl.exe -s -o nul -w "%%{http_code}" http://127.0.0.1:8791/api/control/health 2^>nul') do set "CONTROL_PANEL_STATUS=%%S"
if "%CONTROL_PANEL_STATUS%"=="200" (
  echo 本机服务控制台已经在 8791 端口运行。
  start "" "http://127.0.0.1:8791"
  endlocal
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
endlocal
