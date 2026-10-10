# scripts/build-portable.ps1
# Builds SubTerm in release mode and packages a zero-install portable .zip
$ErrorActionPreference = 'Stop'

Write-Host "Building SubTerm release binary (skipping installers)..." -ForegroundColor Cyan
npx tauri build --no-bundle
# Native commands don't trip $ErrorActionPreference; without this a failed build
# would silently zip whatever stale exe is already in target/.
if ($LASTEXITCODE -ne 0) {
    throw "tauri build failed (exit code $LASTEXITCODE); not packaging."
}

# The embedded RDP client runs as a separate executable that must sit next to subterm.exe.
& "$PSScriptRoot/build-rdp-helper.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "RDP helper build failed; not packaging."
}

$targetExe = "src-tauri/target/release/subterm.exe"
$helperExe = "src-tauri/target/release/subterm-rdp-helper.exe"
if (-not (Test-Path $helperExe)) {
    throw "RDP helper not found at $helperExe"
}
if (-not (Test-Path $targetExe)) {
    throw "Target executable not found at $targetExe"
}

$version = (Get-Content "src-tauri/tauri.conf.json" | ConvertFrom-Json).version
$outDir = "release-portable"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$zipPath = "$outDir/SubTerm-v$version-windows-portable.zip"
Write-Host "Creating portable zip at $zipPath..." -ForegroundColor Cyan
Compress-Archive -Path $targetExe, $helperExe -DestinationPath $zipPath -Force

Write-Host "`nPortable release ready!" -ForegroundColor Green
Write-Host "  Executable: $targetExe"
Write-Host "  ZIP:        $zipPath`n"
