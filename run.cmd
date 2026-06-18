@echo off
chcp 65001 >nul
title ZCode Account Manager
cd /d "%~dp0"
start "" pythonw.exe account_manager.py
