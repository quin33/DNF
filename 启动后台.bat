@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "TAVERN_LOAD_ENV=1"
rem 端口在此显式钉死，避免继承同一命令行窗口里其它项目（xiuxian 用 8790/8787）
rem 残留的同名变量。若要改端口，请同时改本文件、.env 与 cloudflared 配置。
set "PORT=8788"
set "GAME_PORT=8788"
set "ADMIN_HTTP_STATUS="
for /f %%S in ('curl.exe -s -o nul -w "%%{http_code}" http://127.0.0.1:8788/admin 2^>nul') do set "ADMIN_HTTP_STATUS=%%S"
if "%ADMIN_HTTP_STATUS%"=="200" goto :open

set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8788 .*LISTENING"') do set "PORT_PID=%%P"
if "%PORT_PID%"=="" goto :launch

rem 8788 上有进程但 /admin 不返回 200：只回收本项目自己的 node，
rem 绝不无条件 taskkill——否则会误杀原游戏 xiuxian 或其它占用该端口的程序。
set "PORT_IMAGE="
for /f "tokens=1 delims=," %%N in ('tasklist /FI "PID eq %PORT_PID%" /NH /FO CSV 2^>nul') do set "PORT_IMAGE=%%~N"
if /I not "%PORT_IMAGE%"=="node.exe" goto :occupied
echo 8788 上的 node 进程无响应，正在回收 PID %PORT_PID%。
taskkill /PID %PORT_PID% /T /F >nul 2>&1

:launch
start "DNF Admin Server" cmd /k "node server.js"
timeout /t 2 /nobreak >nul

:open
start "" "http://127.0.0.1:8788/admin"
endlocal
exit /b 0

:occupied
echo 8788 端口被 %PORT_IMAGE%（PID %PORT_PID%）占用，未启动 DNF 后台。
echo 请先释放该端口，或在 .env 中改用其它端口。
pause
endlocal
exit /b 1
