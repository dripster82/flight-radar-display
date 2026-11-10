#!/usr/bin/env bash
# Runs the app full screen and restarts it if it ever exits or crashes.
# Started from ~/.config/labwc/autostart by scripts/install.sh.
REPO="$(cd "$(dirname "$0")/.." && pwd)"

while true; do
  KIOSK=1 "$REPO/vendor/electron/electron" "$REPO" --ozone-platform-hint=auto
  sleep 2
done
