@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   启动统一控制台 (端口 8792)
echo ========================================
echo.

REM 检查 8792 是否被占用
for /f "tokens=5" %%a in ('netstat -ano -p tcp ^| findstr ":8792.*LISTENING"') do (
  set "PID=%%a"
  echo [错误] 端口 8792 已被占用 (PID: !PID!)
  echo.
  echo 排查命令: netstat -ano ^| findstr :8792
  echo 停止命令: taskkill /PID !PID! /T /F
  echo.
  pause
  exit /b 1
)

echo [1/2] 启动统一控制台服务 (8792)...
start "统一控制台" node "%~dp0unified-control-server.js"
timeout /t 2 /nobreak >nul

echo [2/2] 打开浏览器...
start http://127.0.0.1:8792

echo.
echo ========================================
echo   统一控制台已启动
echo   访问地址: http://127.0.0.1:8792
echo
echo   提示: 需要同时启动两个游戏的控制台:
echo     - 问道仙坊控制台 (8790)
echo     - DNF 控制台 (8791)
echo ========================================
echo.

endlocal
