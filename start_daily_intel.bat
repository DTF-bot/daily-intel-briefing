@echo off
setlocal

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Python virtual environment was not found: .venv\Scripts\python.exe
  echo Please create/install the project environment first.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue; if ($c) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  echo Daily Intel server is already running on http://127.0.0.1:8001/
) else (
  echo Starting Daily Intel server on http://127.0.0.1:8001/
  start "daily-intel-server" /min ".venv\Scripts\python.exe" -m uvicorn backend.server.app:app --host 127.0.0.1 --port 8001
  timeout /t 3 /nobreak >nul
)

start "" "http://127.0.0.1:8001/config"
echo Opened config page: http://127.0.0.1:8001/config
endlocal
