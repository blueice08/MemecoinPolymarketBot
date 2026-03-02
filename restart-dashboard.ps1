$ErrorActionPreference = 'SilentlyContinue'

$root = "C:\Users\bluei\.openclaw\workspace\polymarket-dashboard"

Write-Host "Stopping existing Node processes..."
taskkill /F /IM node.exe | Out-Null
Start-Sleep -Seconds 1

Write-Host "Starting dashboard server..."
Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command cd '$root'; node server.js"

Start-Sleep -Seconds 1

Write-Host "Starting meme runner..."
Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command cd '$root'; node pump_runner.js"

Write-Host "Done."
Write-Host "Local URL: http://localhost:8787"
