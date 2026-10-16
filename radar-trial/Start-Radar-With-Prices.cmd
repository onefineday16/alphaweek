@echo off
cd /d "%~dp0"
echo AlphaWeek Radar - optional EODHD FREE account test
echo Stop any existing Radar server first. No API key is saved.
echo Open http://127.0.0.1:8787 after the server starts.
set "RADAR_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%RADAR_PY%" (
  "%RADAR_PY%" "%~dp0radar.py" --eodhd
) else (
  py -3 "%~dp0radar.py" --eodhd
)
pause
