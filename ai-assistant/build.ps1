# Packages the add-on as dist\ai-assistant-<version>.xpi (a zip with
# manifest.json at the root). Usage: powershell -File build.ps1
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$xpi = Join-Path $dist "ai-assistant-$version.xpi"
if (Test-Path $xpi) { Remove-Item $xpi }

$include = @("manifest.json", "background.js", "lib", "panel", "compose", "options", "scripts", "icons", "experiments", "LICENSE")
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($xpi, "Create")
try {
  foreach ($item in $include) {
    $path = Join-Path $root $item
    if (-not (Test-Path $path)) { continue }
    $files = if ((Get-Item $path).PSIsContainer) { Get-ChildItem $path -Recurse -File } else { Get-Item $path }
    foreach ($f in $files) {
      # Zip entries must use forward slashes.
      $rel = $f.FullName.Substring($root.Length + 1).Replace("\", "/")
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, "Optimal") | Out-Null
    }
  }
} finally {
  $zip.Dispose()
}
Write-Output $xpi
