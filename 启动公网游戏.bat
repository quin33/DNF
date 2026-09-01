@echo off
setlocal
cd /d "%~dp0"
set "TAVERN_LOAD_ENV=1"
sc query cloudflared | find "RUNNING" >nul
if errorlevel 1 net start cloudflared >nul 2>&1

netstat -ano | findstr /R /C:":8788 .*LISTENING" >nul
if errorlevel 1 (
  start "DNF 游戏服务" /min cmd /c "启动后台.bat"
  timeout /t 3 /nobreak >nul
)
start "" "https://dnf.xiuxiangame.dpdns.org"

endlocal
