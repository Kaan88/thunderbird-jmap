# Removes the ai_assistant_claude native-messaging host for the current user.
$name = 'ai_assistant_claude'
foreach ($k in @("HKCU:\Software\Mozilla\NativeMessagingHosts\$name", "HKCU:\Software\Thunderbird\NativeMessagingHosts\$name")) {
  if (Test-Path $k) { Remove-Item $k -Recurse -Force; Write-Host "removed $k" }
}
$dest = Join-Path $env:LOCALAPPDATA 'thunderbird-ai-assistant\native'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force; Write-Host "removed $dest" }
