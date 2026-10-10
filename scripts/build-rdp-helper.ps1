# scripts/build-rdp-helper.ps1
# Builds the RDP helper (its own crate, not part of the main workspace) and puts it
# next to subterm.exe so the app can find it. Run before packaging; build-portable.ps1
# calls it for you.
$ErrorActionPreference = 'Stop'

Write-Host "Building RDP helper..." -ForegroundColor Cyan
cargo build --release --manifest-path src-tauri/rdp-helper/Cargo.toml
if ($LASTEXITCODE -ne 0) {
    throw "RDP helper build failed (exit code $LASTEXITCODE)."
}

$built = "src-tauri/rdp-helper/target/release/subterm-rdp-helper.exe"
if (-not (Test-Path $built)) {
    throw "Helper executable not found at $built"
}
New-Item -ItemType Directory -Force -Path "src-tauri/target/release" | Out-Null
Copy-Item $built "src-tauri/target/release/subterm-rdp-helper.exe" -Force
Write-Host "RDP helper ready: src-tauri/target/release/subterm-rdp-helper.exe" -ForegroundColor Green
