#!/bin/bash
# Development builds are not notarized. Prepare only this adjacent PhotoCull.app.
set -euo pipefail
photocull_bundle="$(cd "$(dirname "$0")" && pwd)/PhotoCull.app"
if [[ ! -d "$photocull_bundle/Contents" ]]; then
  printf '%s\n' 'Keep this script beside PhotoCull.app.'
  exit 1
fi
/usr/bin/xattr -dr com.apple.quarantine "$photocull_bundle" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - --entitlements "$photocull_bundle/Contents/Resources/app/assets/entitlements.mac.plist" "$photocull_bundle"
/usr/bin/codesign --verify --deep --strict "$photocull_bundle"
printf '%s\n' 'PhotoCull is ready. Open PhotoCull.app.'
