#!/bin/bash
# archive-version.sh — snapshot the current Web/ into Web/versions/X.Y.Z/
# Run from the repo root: ./archive-version.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$SCRIPT_DIR/Web"

# ── Read version from version.js ────────────────────────────────────────────
VERSION=$(grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' "$WEB_DIR/version.js" | head -1)

if [ -z "$VERSION" ]; then
  echo "ERROR: Could not read version from Web/version.js"
  exit 1
fi

TARGET="$WEB_DIR/versions/$VERSION"

# ── Guard against overwriting an existing archive ───────────────────────────
if [ -d "$TARGET" ]; then
  echo "WARNING: Version $VERSION is already archived at Web/versions/$VERSION/"
  read -r -p "Overwrite? [y/N] " response
  [[ "$response" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
  rm -rf "$TARGET"
fi

# ── Copy the site, excluding the versions/ folder itself ────────────────────
echo "Archiving v$VERSION..."
mkdir -p "$TARGET"
rsync -a --exclude='versions/' "$WEB_DIR/" "$TARGET/"
echo "  Copied Web/ → Web/versions/$VERSION/"

# ── Update the versions manifest ────────────────────────────────────────────
python3 - "$WEB_DIR/versions/versions.js" "$VERSION" <<'PYEOF'
import json, re, sys
manifest_path, new_version = sys.argv[1], sys.argv[2]
try:
    content = open(manifest_path).read()
    match = re.search(r'\[.*?\]', content, re.DOTALL)
    versions = json.loads(match.group()) if match else []
except Exception:
    versions = []
if new_version not in versions:
    versions.insert(0, new_version)
open(manifest_path, 'w').write('window.OBIE_VERSIONS = ' + json.dumps(versions) + ';\n')
print('  Manifest updated:', versions)
PYEOF

echo ""
echo "Done. Version $VERSION is now available at:"
echo "  Web/versions/$VERSION/"
echo ""
echo "Remember to commit and push so it appears on GitHub Pages."
