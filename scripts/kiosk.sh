#!/usr/bin/env bash
# Runs the app full screen and restarts it if it ever exits or crashes.
# Started from ~/.config/labwc/autostart by scripts/install.sh.
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# With power-cut protection on (scripts/protect.sh), the app keeps its data in the writable storage
# areas: its settings in one, the browser's data (the Flightradar24 sign-in) in another.
STORAGE=/var/lib/flight-radar-data
if mountpoint -q "$STORAGE/settings"; then export FLIGHT_RADAR_SETTINGS_DIR="$STORAGE/settings/data"; fi
if mountpoint -q "$STORAGE/browser"; then export FLIGHT_RADAR_DATA_DIR="$STORAGE/browser/data"; fi

# The Touch Display 2 is a portrait panel (720x1280). Turn the picture to landscape; touch follows
# because scripts/install.sh maps the touchscreen to this output. screenRotation in config.json is
# 90 or 270 (whichever way up the enclosure holds the screen), or 0 to leave it alone.
rotation="$(sed -n 's/.*"screenRotation": *\([0-9]*\).*/\1/p' "$REPO/config.json")"
if command -v wlr-randr >/dev/null; then
  screen="$(wlr-randr | awk '/^DSI-/ {print $1; exit}')"
  case "${rotation:-0}" in 90|180|270) transform="$rotation" ;; *) transform=normal ;; esac
  [ -n "$screen" ] && wlr-randr --output "$screen" --transform "$transform"
fi

while true; do
  KIOSK=1 "$REPO/vendor/electron/electron" "$REPO" --ozone-platform-hint=auto
  sleep 2
done
