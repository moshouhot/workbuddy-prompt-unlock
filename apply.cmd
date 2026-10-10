@echo off
setlocal
node "%~dp0wb.mjs" apply --close --restart %*
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
