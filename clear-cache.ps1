# PowerShell script to clear electron-builder cache
$cachePath = "$env:LOCALAPPDATA\electron-builder\Cache"
if (Test-Path $cachePath) {
    Remove-Item -Path $cachePath -Recurse -Force
    Write-Host "Cleared electron-builder cache at: $cachePath"
} else {
    Write-Host "Cache directory not found: $cachePath"
}

