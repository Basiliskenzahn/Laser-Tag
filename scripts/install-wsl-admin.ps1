# Run this script from an Administrator PowerShell window.
$ErrorActionPreference = 'Stop'

dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
wsl --set-default-version 2

Write-Host ''
Write-Host 'WSL features are enabled. Restart Windows before starting Docker Desktop.'
