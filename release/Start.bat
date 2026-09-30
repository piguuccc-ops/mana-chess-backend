@echo off
rem Mana Chess backend: fiokok, paklik, baratok, szobak es a vezerlopult. Dupla kattintas eleg.
title Mana Chess backend
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Ehhez Node.js kell, de nincs telepitve.
  echo   Toltsd le az LTS verziot: https://nodejs.org  - telepites utan inditsd ujra ezt a fajlt.
  echo.
  echo   Node.js is not installed. Get the LTS version from https://nodejs.org and run this file again.
  echo.
  start "" https://nodejs.org/
  pause
  exit /b 1
)
node backend.mjs %*
echo.
pause
