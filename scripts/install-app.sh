#!/bin/sh
set -e
APP="GH Dashboard.app"
npx tauri build --bundles app
DATA="$HOME/Library/Application Support/local.gh-org-dashboard"
if [ ! -f "$DATA/dashboard.db" ] && [ -f data/dashboard.db ]; then
  mkdir -p "$DATA"
  sqlite3 data/dashboard.db ".backup '$DATA/dashboard.db'"
  [ -f "$DATA/presets.json" ] || cp presets.json "$DATA/presets.json"
  echo "Seeded app data from data/ and presets.json"
fi
osascript -e 'if application "GH Dashboard" is running then tell application "GH Dashboard" to quit'
rm -rf "/Applications/$APP"
ditto "src-tauri/target/release/bundle/macos/$APP" "/Applications/$APP"
echo "Installed /Applications/$APP"
