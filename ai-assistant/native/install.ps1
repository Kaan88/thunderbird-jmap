# Installs the ai_assistant_claude native-messaging host for the current user.
$ErrorActionPreference = 'Stop'
$name = 'ai_assistant_claude'
$dest = Join-Path $env:LOCALAPPDATA 'thunderbird-ai-assistant\native'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'host.js') $dest -Force
Copy-Item (Join-Path $PSScriptRoot 'mcp-bridge.js') $dest -Force

$node = (Get-Command node -ErrorAction Stop).Source
$hostJs = Join-Path $dest 'host.js'
$bat = Join-Path $dest 'host.bat'
Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`n`"$node`" `"$hostJs`" %*"

$manifestPath = Join-Path $dest "$name.json"
$manifest = [ordered]@{
  name = $name
  description = 'Claude Code bridge for the Thunderbird AI Assistant'
  path = $bat
  type = 'stdio'
  allowed_extensions = @('ai-assistant@thunderbird-jmap')
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

# Thunderbird (toolkit NativeManifests.sys.mjs) reads HKCU\Software\Mozilla\NativeMessagingHosts\<name>
$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$name"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath
Write-Host "node:     $node"
Write-Host "manifest: $manifestPath"
Write-Host "registry: $key = $manifestPath"
