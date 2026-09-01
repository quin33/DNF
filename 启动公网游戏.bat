@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "TAVERN_LOAD_ENV=1"
rem 端口在此显式钉死，避免继承同一命令行窗口里其它项目（xiuxian 用 8790/8787）
rem 残留的同名变量。若要改端口，请同时改本文件、.env 与 cloudflared 配置。
set "PORT=8788"
set "GAME_PORT=8788"
rem cloudflared 是两个项目共用的同一条隧道（见 %USERPROFILE%\.cloudflared\config.yml：
rem xiuxiangame.dpdns.org→8787，dnf.xiuxiangame.dpdns.org→8788），此处只确保服务在跑，
rem 不要 net stop / 重装隧道，否则会同时断掉原游戏的公网访问。
sc query cloudflared | find "RUNNING" >nul
if errorlevel 1 net start cloudflared >nul 2>&1

netstat -ano | findstr /R /C:":8788 .*LISTENING" >nul
if errorlevel 1 (
  start "DNF 游戏服务" /min cmd /c "启动后台.bat"
  timeout /t 3 /nobreak >nul
)
start "" "https://dnf.xiuxiangame.dpdns.org"

endlocal
