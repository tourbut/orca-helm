@echo off
chcp 65001 >nul
node "%~dp0bin\orca-helm.mjs" %*
