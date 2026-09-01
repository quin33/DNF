@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TAVERN_LOAD_ENV=1"
set "ADMIN_HTTP_STATUS="
for /f %%S in ('curl.exe -s -o nul -w "%%{http_code}" http://127.0.0.1:8788/admin 2^>nul') do set "ADMIN_HTTP_STATUS=%%S"
if not "%ADMIN_HTTP_STATUS%"=="200" (
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8788 .*LISTENING"') do taskkill /PID %%P /F >nul 2>&1
  start "DNF Admin Server" cmd /k "node server.js"
  timeout /t 2 /nobreak >nul
)
start "" "http://127.0.0.1:8788/admin"
