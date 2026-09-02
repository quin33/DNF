@echo off
setlocal
set "TAVERN_LOAD_ENV=1"
sc query cloudflared | find "RUNNING" >nul
if errorlevel 1 net start cloudflared >nul 2>&1

netstat -ano | findstr /R /C:":8787 .*LISTENING" >nul
if errorlevel 1 (
  start "修仙游戏服务" /min cmd /c "cd /d %~dp0 && 启动后台.bat"
  timeout /t 3 /nobreak >nul
)
start "" "https://xiuxiangame.dpdns.org"

endlocal
