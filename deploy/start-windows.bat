@echo off
rem Vote dashboard launcher for Windows. Double-click this file.
rem This file is intentionally ASCII-only; all messages are printed by deploy\launcher.mjs.
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 goto nonode
node deploy\launcher.mjs
echo.
pause
exit /b
:nonode
echo.
echo Node.js is not installed. Please install Node.js 22 LTS from https://nodejs.org/ and run this file again.
echo.
pause
exit /b 1
