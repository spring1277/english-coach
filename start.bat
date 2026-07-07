@echo off
cd /d "%~dp0"
start "" http://localhost:8735
python server.py
