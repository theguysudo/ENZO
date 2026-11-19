# ENZO desktop launcher stop-shortcut target: kills the running server by pid.
@echo off
if not exist "%APPDATA%\ENZO\enzo.pid" (
  echo ENZO is not running.
  exit /b 0
)
for /f %%i in (%APPDATA%\ENZO\enzo.pid) do taskkill /F /PID %%i /T >nul 2>&1
del "%APPDATA%\ENZO\enzo.pid" >nul 2>&1
echo ENZO stopped.
