#!/usr/bin/env bash
# Runs the app full screen and restarts it if it ever exits or crashes.
# Started from ~/.config/labwc/autostart by scripts/install.sh.
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# With power-cut protection on (scripts/protect.sh), the app keeps its data in the writable storage
# areas: its settings in one, the browser's data (the Flightradar24 sign-in) in another.
STORAGE=/var/lib/flight-radar-data
if mountpoint -q "$STORAGE/settings"; then export FLIGHT_RADAR_SETTINGS_DIR="$STORAGE/settings/data"; fi
if mountpoint -q "$STORAGE/browser"; then export FLIGHT_RADAR_DATA_DIR="$STORAGE/browser/data"; fi

while true; do
  KIOSK=1 "$REPO/vendor/electron/electron" "$REPO" --ozone-platform-hint=auto
  sleep 2
done
