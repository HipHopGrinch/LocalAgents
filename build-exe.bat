@echo off
cd /d "%~dp0"
title LocalAgents Studio - Build EXE

echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo Building UI + packaging Windows EXE...
call npm run dist
if errorlevel 1 (
  echo Package failed.
  pause
  exit /b 1
)

echo.
echo Done. Outputs in the release\ folder:
echo   - LocalAgents Studio-*-portable.exe  (self-contained, no install)
echo   - LocalAgents Studio-*-setup.exe     (NSIS installer)
echo.
explorer release
pause
