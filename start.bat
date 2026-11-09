@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js не найден. Установите LTS с https://nodejs.org и запустите start.bat снова.
  pause
  exit /b 1
)
echo Запуск GamesScoreFSD: http://localhost:3000
node server\index.js
pause
