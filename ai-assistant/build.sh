#!/bin/bash
# Packages the add-on as dist/ai-assistant-<version>.xpi (Linux/macOS; build.ps1 is the Windows equivalent).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
V=$(grep -m1 '"version"' manifest.json | sed 's/.*: *"\(.*\)".*/\1/')
mkdir -p dist; rm -f "dist/ai-assistant-$V.xpi"
python3 -I - "dist/ai-assistant-$V.xpi" <<'PY'
import os, sys, zipfile
items = ["manifest.json", "background.js", "lib", "panel", "compose", "options", "scripts", "icons", "experiments", "LICENSE"]
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for i in items:
        if os.path.isdir(i):
            for r, _, fs in os.walk(i):
                for f in sorted(fs):
                    z.write(os.path.join(r, f))
        elif os.path.exists(i):
            z.write(i)
PY
echo "dist/ai-assistant-$V.xpi"
