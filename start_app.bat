@echo off
chcp 65001 > nul
echo ===================================================
echo   📘 StudyHub 勉強アプリを起動しています...
echo ===================================================
cd /d "%~dp0"
python server.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [お知らせ] Pythonサーバーの起動に失敗したため、直接ブラウザで開きます。
    start index.html
)
pause
