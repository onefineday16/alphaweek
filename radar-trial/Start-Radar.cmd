@echo off
cd /d "%~dp0"
echo AlphaWeek Radar - free news trial
echo Open http://127.0.0.1:8787 in your browser after the server starts.
echo Keep this window open. Press Ctrl+C to stop.
set "RADAR_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%RADAR_PY%" (
  "%RADAR_PY%" "%~dp0radar.py"
) else (
  py -3 "%~dp0radar.py"
)
pause
