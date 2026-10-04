# scripts/build-portable.ps1
# Builds SubTerm in release mode and packages a zero-install portable .zip
$ErrorActionPreference = 'Stop'

Write-Host "Building SubTerm release binary (skipping installers)..." -ForegroundColor Cyan
npx tauri build --no-bundle

$targetExe = "src-tauri/target/release/subterm.exe"
if (-not (Test-Path $targetExe)) {
    throw "Target executable not found at $targetExe"
}

$version = (Get-Content "src-tauri/tauri.conf.json" | ConvertFrom-Json).version
$outDir = "release-portable"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$zipPath = "$outDir/SubTerm-v$version-windows-portable.zip"
Write-Host "Creating portable zip at $zipPath..." -ForegroundColor Cyan
Compress-Archive -Path $targetExe -DestinationPath $zipPath -Force

Write-Host "`nPortable release ready!" -ForegroundColor Green
Write-Host "  Executable: $targetExe"
Write-Host "  ZIP:        $zipPath`n"
