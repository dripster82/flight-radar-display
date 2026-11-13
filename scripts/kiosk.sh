#!/usr/bin/env bash
# Runs the app full screen and restarts it if it ever exits or crashes.
# Started from ~/.config/labwc/autostart by scripts/install.sh.
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# With power-cut protection on (scripts/protect.sh), the app keeps its data in the writable storage
# areas: its settings in one, the browser's data (the Flightradar24 sign-in) in another.
STORAGE=/var/lib/flight-radar-data
if mountpoint -q "$STORAGE/settings"; then export FLIGHT_RADAR_SETTINGS_DIR="$STORAGE/settings/data"; fi
if mountpoint -q "$STORAGE/browser"; then export FLIGHT_RADAR_DATA_DIR="$STORAGE/browser/data"; fi
# The web cache and the diagnostic log have areas of their own (no backups; see data-area.sh).
# There are two browser profiles, each with a page cache and a script cache under the same limit,
# so the limit is a quarter of the area.
if mountpoint -q "$STORAGE/cache"; then
  export FLIGHT_RADAR_CACHE_DIR="$STORAGE/cache/data"
  export FLIGHT_RADAR_CACHE_MB="$(( $(df -Pm "$STORAGE/cache" | awk 'NR==2 {print $2}') / 4 ))"
fi
# The log: read it with  tail -50 "$FLIGHT_RADAR_LOG_DIR/flight-radar.log"  (see src/log.js).
if mountpoint -q "$STORAGE/log"; then export FLIGHT_RADAR_LOG_DIR="$STORAGE/log/data"
else export FLIGHT_RADAR_LOG_DIR="${FLIGHT_RADAR_SETTINGS_DIR:-$HOME/.config/flight-radar-display}/logs"; fi
mkdir -p "$FLIGHT_RADAR_LOG_DIR"
note() { echo "$(date '+%Y-%m-%d %H:%M:%S') kiosk    $*" >> "$FLIGHT_RADAR_LOG_DIR/flight-radar.log"; }
note "session started, $(uptime -p 2>/dev/null || echo 'uptime unknown') since power-on"

# The Touch Display 2 is a portrait panel (720x1280). Turn the picture to landscape; touch follows
# because scripts/install.sh maps the touchscreen to this output. screenRotation in config.json is
# 90 or 270 (whichever way up the enclosure holds the screen), or 0 to leave it alone.
rotation="$(sed -n 's/.*"screenRotation": *\([0-9]*\).*/\1/p' "$REPO/config.json")"
if command -v wlr-randr >/dev/null; then
  screen="$(wlr-randr | awk '/^DSI-/ {print $1; exit}')"
  case "${rotation:-0}" in 90|180|270) transform="$rotation" ;; *) transform=normal ;; esac
  [ -n "$screen" ] && wlr-randr --output "$screen" --transform "$transform"
fi

# The desktop's own panel and wallpaper start alongside this script and would be on show until the
# app is up, so they are closed (lwrespawn is what would bring them straight back).
pkill -f lwrespawn; pkill -f wf-panel-pi; pkill -f 'pcmanfm.*--desktop'

while true; do
  KIOSK=1 "$REPO/vendor/electron/electron" "$REPO" --ozone-platform-hint=auto
  note "the app stopped (exit code $?); starting it again"
  sleep 2
done
