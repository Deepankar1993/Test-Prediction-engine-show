@echo off
title Sylox Evaluation Kit
cd /d "%~dp0"
where py >nul 2>nul && ( py sylox_kit.py ) || ( python sylox_kit.py )
pause
