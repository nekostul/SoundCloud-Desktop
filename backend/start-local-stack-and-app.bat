@echo off
setlocal

set "ROOT_DIR=%~dp0"
set "APP_EXE=%LOCALAPPDATA%\sc-desk\sc-desk.exe"

call "%ROOT_DIR%start-local-api.bat"

if exist "%APP_EXE%" (
  ping -n 6 127.0.0.1 >nul
  start "" "%APP_EXE%"
)

exit /b 0
