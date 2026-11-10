#!/usr/bin/env bash
# Sets up a Raspberry Pi (Raspberry Pi OS 64-bit Desktop) as the flight radar appliance:
# ADS-B decoder (readsb), local map (tar1090), GPS (gpsd), and this app in kiosk mode on boot.
#
# Run from the repo checkout as the desktop user (not root):
#   scripts/install.sh [LATITUDE LONGITUDE]
#
# Safe to run again; finished steps are skipped. Flightradar24 feeding is deliberately
# NOT set up here, because that registers the receiver: see scripts/install-fr24.sh.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_DIR="$REPO/vendor/electron"
ELECTRON_VERSION="$(sed -n 's/.*"electron": *"[^0-9]*\([0-9.]*\)".*/\1/p' "$REPO/package.json")"
GPSD_CONNECTOR="--net-connector 127.0.0.1,2947,gpsd_in"

step() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" -ne 0 ] || { echo "Run as the desktop user, not root (sudo is used where needed)." >&2; exit 1; }
[ "$(uname -m)" = "aarch64" ] || { echo "This needs 64-bit Raspberry Pi OS (aarch64)." >&2; exit 1; }
[ -n "$ELECTRON_VERSION" ] || { echo "Could not read the Electron version from package.json." >&2; exit 1; }
if [ $# -ne 0 ] && [ $# -ne 2 ]; then echo "Usage: $0 [LATITUDE LONGITUDE]" >&2; exit 1; fi

step "System packages"
sudo apt-get update
sudo apt-get install -y wget unzip gpsd gpsd-clients

step "ADS-B decoder (readsb)"
if [ ! -x /usr/bin/readsb ]; then
  sudo bash -c "$(wget -O - https://github.com/wiedehopf/adsb-scripts/raw/master/readsb-install.sh)"
else
  echo "already installed"
fi

step "Local map (tar1090)"
if [ ! -d /usr/local/share/tar1090 ]; then
  sudo bash -c "$(wget -nv -O - https://github.com/wiedehopf/tar1090/raw/master/install.sh)"
else
  echo "already installed"
fi

step "GPS position into the decoder"
# readsb takes its own position from gpsd when a fix is available, so the map follows the device.
if ! grep -q 'gpsd_in' /etc/default/readsb; then
  sudo sed -i "s|^NET_OPTIONS=\"|NET_OPTIONS=\"$GPSD_CONNECTOR |" /etc/default/readsb
  sudo systemctl restart readsb
else
  echo "already configured"
fi

if [ $# -eq 2 ]; then
  step "Home location (used when there is no GPS fix)"
  sudo readsb-set-location "$1" "$2"
fi

step "Electron $ELECTRON_VERSION"
if [ "$(cat "$ELECTRON_DIR/version" 2>/dev/null)" != "$ELECTRON_VERSION" ]; then
  zip="$(mktemp --suffix=.zip)"
  wget -nv -O "$zip" "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-linux-arm64.zip"
  rm -rf "$ELECTRON_DIR"
  mkdir -p "$ELECTRON_DIR"
  unzip -q "$zip" -d "$ELECTRON_DIR"
  rm -f "$zip"
  # Chromium's sandbox helper must be owned by root and setuid to work.
  sudo chown root:root "$ELECTRON_DIR/chrome-sandbox"
  sudo chmod 4755 "$ELECTRON_DIR/chrome-sandbox"
else
  echo "already installed"
fi

step "Kiosk on boot"
sudo raspi-config nonint do_boot_behaviour B4   # boot to desktop, logged in
sudo raspi-config nonint do_blanking 1          # never blank the screen
autostart="$HOME/.config/labwc/autostart"
mkdir -p "$(dirname "$autostart")"
if ! grep -qF "$REPO/scripts/kiosk.sh" "$autostart" 2>/dev/null; then
  echo "$REPO/scripts/kiosk.sh &" >> "$autostart"
else
  echo "already configured"
fi

step "Done"
echo "Local map:  http://localhost/tar1090/"
echo "Reboot to start the kiosk:  sudo reboot"
