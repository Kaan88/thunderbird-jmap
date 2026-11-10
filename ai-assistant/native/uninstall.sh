#!/bin/bash
# Removes the ai_assistant_claude native-messaging host for the current user (Linux).
NAME=ai_assistant_claude
rm -f "$HOME/.mozilla/native-messaging-hosts/$NAME.json"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/thunderbird-ai-assistant"
echo removed
