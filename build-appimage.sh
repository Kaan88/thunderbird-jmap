#!/bin/bash
# Build the Linux AppImage from the packaged tarball (./mach package output).
# Usage: ./build-appimage.sh [path/to/thunderbird-*.linux-x86_64.tar.xz]
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
TARBALL="${1:-/mnt/E/tb-build/obj-linux/dist/thunderbird-162.0a1.en-US.linux-x86_64.tar.xz}"
OUT="work/Thunderbird-JMAP-162.0a1-x86_64.AppImage"
APPDIR="work/AppDir"
[ -f "$TARBALL" ] || { echo "tarball not found: $TARBALL" >&2; exit 1; }
command -v appimagetool >/dev/null || { echo "appimagetool not installed" >&2; exit 1; }

rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/lib" "$APPDIR/usr/share/applications"
tar -xf "$TARBALL" -C "$APPDIR/usr/lib"
mv "$APPDIR/usr/lib/thunderbird" "$APPDIR/usr/lib/thunderbird-jmap"
install -m755 packaging/AppRun "$APPDIR/AppRun"
cp packaging/thunderbird-jmap.desktop "$APPDIR/"
cp packaging/thunderbird-jmap.desktop "$APPDIR/usr/share/applications/"
cp packaging/thunderbird-jmap.png "$APPDIR/"

ARCH=x86_64 appimagetool "$APPDIR" "$OUT"
echo "Built $OUT"
