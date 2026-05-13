@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%"

if not exist node_modules (
  call corepack pnpm install
  if errorlevel 1 (
    popd
    exit /b 1
  )
)

call corepack pnpm build
if errorlevel 1 (
  popd
  exit /b 1
)

start "SoundCloud Backend" cmd /k "cd /d ""%SCRIPT_DIR%"" && corepack pnpm start:prod"

popd
exit /b 0
