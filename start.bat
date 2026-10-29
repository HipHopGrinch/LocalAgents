@echo off
cd /d "%~dp0"
title LocalAgents Studio

echo Building latest UI...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo Starting LocalAgents Studio...
call npm start
