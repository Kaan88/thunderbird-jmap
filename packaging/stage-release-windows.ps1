# Stage the release zip, add the update policy, build+sign the MAR, write update.xml.
# Usage: powershell -File stage-release.ps1
$ErrorActionPreference = 'Stop'
$repo = 'Kaan88/thunderbird-jmap'
$zip = 'E:\tb-obj-rel\dist\thunderbird-162.0a1.en-US.win64.zip'
$st = 'E:\tb-build\stage'
$out = 'E:\tb-build\release'

$ini = Get-Content 'E:\tb-obj-rel\dist\bin\application.ini'
$buildId = (($ini | Select-String '^BuildID=').Line -split '=')[1].Trim()
$version = (($ini | Select-String '^Version=').Line -split '=')[1].Trim()
$tag = "v$version-$buildId"
$base = "thunderbird-jmap-$version-$buildId-win64"

if (Test-Path $st) { Remove-Item -Recurse -Force $st }
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory $st, $out | Out-Null
Expand-Archive $zip $st
$app = Join-Path $st 'thunderbird'

# Point the updater at our GitHub releases instead of Mozilla's servers.
New-Item -ItemType Directory -Force (Join-Path $app 'distribution') | Out-Null
$policies = @{ policies = @{ AppUpdateURL = "https://github.com/$repo/releases/latest/download/update.xml" } } | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $app 'distribution\policies.json'), $policies, (New-Object Text.UTF8Encoding $false))

# Bundle the AI assistant add-on: Thunderbird installs distribution\extensions\*.xpi into profiles on first run.
$aiDir = 'E:\tb-build\thunderbird-ai-assistant'
$xpi = & powershell -NoProfile -File (Join-Path $aiDir 'build.ps1') | Select-Object -Last 1
New-Item -ItemType Directory -Force (Join-Path $app 'distribution\extensions') | Out-Null
Copy-Item $xpi (Join-Path $app 'distribution\extensions\ai-assistant@thunderbird-jmap.xpi') -Force

# Zip for fresh installs.
Compress-Archive -Path $app -DestinationPath (Join-Path $out "$base.zip")

# Signed complete MAR.
$env:MOZILLABUILD = 'C:\mozilla-build\'
$ErrorActionPreference = 'Continue'
& C:\mozilla-build\msys2\usr\bin\bash.exe -l /e/tb-build/make-mar.sh /e/tb-build/stage/thunderbird "/e/tb-build/release/$base.complete.mar" 2>$null
$ErrorActionPreference = 'Stop'
$mar = Join-Path $out "$base.complete.mar"
if (-not (Test-Path $mar)) { throw 'MAR not produced' }

$hash = (Get-FileHash -Algorithm SHA512 $mar).Hash.ToLower()
$size = (Get-Item $mar).Length
$url = "https://github.com/$repo/releases/download/$tag/$base.complete.mar"
$xml = @"
<?xml version="1.0" encoding="UTF-8"?>
<updates>
  <update type="minor" displayVersion="$version" appVersion="$version" platformVersion="$version" buildID="$buildId" detailsURL="https://github.com/$repo/releases/tag/$tag">
    <patch type="complete" URL="$url" hashFunction="sha512" hashValue="$hash" size="$size"/>
  </update>
</updates>
"@
[IO.File]::WriteAllText((Join-Path $out 'update.xml'), $xml, (New-Object Text.UTF8Encoding $false))
"tag=$tag"
Get-ChildItem $out | Select-Object Name, Length | Format-Table -AutoSize | Out-String
