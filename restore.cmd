@echo off
setlocal
node "%~dp0wb.mjs" restore --close --restart %*
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
