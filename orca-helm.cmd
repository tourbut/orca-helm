@echo off
setlocal EnableExtensions
set "CP="
for /f "tokens=2 delims=:" %%A in ('chcp') do set "CP=%%A"
if defined CP set "CP=%CP: =%"
if defined CP set "CP=%CP:.=%"
chcp 65001 >nul
node "%~dp0bin\orca-helm.mjs" %*
set "EC=%ERRORLEVEL%"
if not "%CP%"=="" chcp %CP% >nul
endlocal & exit /b %EC%
