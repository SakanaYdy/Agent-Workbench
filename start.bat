@echo off
setlocal
pushd "%~dp0" || exit /b 1

where node.exe >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found. Install Node.js 18.15 or newer.
    pause
    popd
    exit /b 1
)

node.exe --preserve-symlinks --preserve-symlinks-main server.mjs
set "workbenchExit=%errorlevel%"
if not "%workbenchExit%"=="0" pause
popd
exit /b %workbenchExit%
