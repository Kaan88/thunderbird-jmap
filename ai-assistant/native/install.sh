#!/bin/bash
# Installs the ai_assistant_claude native-messaging host for the current user (Linux).
# Needs Node.js and Claude Code (logged in once). Rerun if Node.js moves.
set -euo pipefail
NAME=ai_assistant_claude
SRC="$(dirname "$(readlink -f "$0")")"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/thunderbird-ai-assistant/native"
NODE="$(command -v node)" || { echo "node not found; install Node.js first" >&2; exit 1; }
mkdir -p "$DEST"
cp -f "$SRC/host.js" "$SRC/mcp-bridge.js" "$DEST/"
printf '#!/bin/sh\nexec "%s" "%s/host.js" "$@"\n' "$NODE" "$DEST" > "$DEST/host.sh"
chmod +x "$DEST/host.sh"
cat > "$DEST/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Claude Code bridge for the Thunderbird AI Assistant",
  "path": "$DEST/host.sh",
  "type": "stdio",
  "allowed_extensions": ["ai-assistant@thunderbird-jmap"]
}
JSON
# Thunderbird reads ~/.mozilla/native-messaging-hosts (and ~/.thunderbird/native-messaging-hosts).
for d in "$HOME/.mozilla/native-messaging-hosts" "$HOME/.thunderbird/native-messaging-hosts"; do
  mkdir -p "$d"; ln -sf "$DEST/$NAME.json" "$d/$NAME.json"
done
echo "node:     $NODE"
echo "manifest: $DEST/$NAME.json"
