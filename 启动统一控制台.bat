@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   启动统一控制台 (端口 8792)
echo ========================================
echo.

REM 检查 8792 是否被占用. 循环内只取 PID, 提示信息放到循环外,
REM 因为 echo 里的右括号会提前闭合 for do 代码块.
set "PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8792 .*LISTENING"') do set "PID=%%P"
if defined PID goto :port_busy

echo [1/2] 启动统一控制台服务 (8792)...
start "统一控制台" node "%~dp0unified-panel.js"
timeout /t 5 /nobreak >nul

echo [2/2] 打开浏览器...
start http://127.0.0.1:8792

echo.
echo ========================================
echo   统一控制台已启动
echo   访问地址: http://127.0.0.1:8792
echo.
echo   两个游戏服务由统一控制台自动拉起:
echo     - 问道仙坊 (8787)
echo     - DNF (8788)
echo.
echo   不要同时运行旧的 启动控制台.bat, 会抢同一个游戏端口.
echo ========================================
echo.

endlocal
exit /b 0

:port_busy
echo [错误] 端口 8792 已被占用 (PID: %PID%)
echo.
echo 排查命令: netstat -ano ^| findstr :8792
echo 停止命令: taskkill /PID %PID% /T /F
echo.
pause
endlocal
exit /b 1
