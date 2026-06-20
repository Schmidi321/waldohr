@echo off
title Waldohr Server
cd /d "%~dp0.."
echo ============================================
echo   Waldohr laeuft gleich auf:
echo   http://localhost:8080
echo.
echo   Fenster offen lassen. Strg+C beendet den Server.
echo ============================================
echo.
start "" http://localhost:8080
node scripts\serve.mjs
pause
