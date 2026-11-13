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
sudo apt-get install -y wget unzip gpsd gpsd-clients wlr-randr plymouth plymouth-themes

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

step "Receiver position"
# The app decides the receiver's position (the home pin, or a held GPS position when away; see
# src/location.js) and sets it in the decoder itself. The decoder must not also follow the GPS
# directly, or the map centre would drift, so an earlier install's GPS link is taken out.
if grep -q 'gpsd_in' /etc/default/readsb; then
  sudo sed -i "s|$GPSD_CONNECTOR ||" /etc/default/readsb
  sudo systemctl restart readsb
fi
if [ $# -eq 2 ]; then
  sudo readsb-set-location "$1" "$2" # a starting position, until a postcode or the GPS gives one
fi

step "Range rings and distance units on the local map"
# Distance circles around the receiver, at the distances listed in config.json, in its distanceUnits
# (km, miles or nautical). Only distances change unit: altitude stays in feet and speed in knots.
# tar1090 draws rings by default, but at 100-250 nautical miles, which is off screen at a local zoom.
rings="$(sed -n 's/.*"rangeRings": *\[\([0-9., ]*\)\].*/\1/p' "$REPO/config.json")"
case "$(sed -n 's/.*"distanceUnits": *"\([a-z]*\)".*/\1/p' "$REPO/config.json")" in
  km) units=metric ;;
  miles) units=imperial ;;
  *) units=nautical ;;
esac
map_config=/usr/local/share/tar1090/html/config.js
if [ -n "$rings" ] && [ -f "$map_config" ]; then
  sudo sed -i '/flight-radar-display$/d' "$map_config"   # replace our earlier lines, if any
  printf '%s\n' \
    "distanceUnits = \"$units\"; // flight-radar-display" \
    "SiteShow = true; // flight-radar-display" \
    "SiteCircles = true; // flight-radar-display" \
    "SiteCirclesDistances = new Array($rings); // flight-radar-display" | sudo tee -a "$map_config" >/dev/null
  echo "rings at $rings ($units)"
else
  echo "skipped (no rangeRings in config.json, or the map is not installed)"
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

step "Screen brightness control"
# Lets the app (running as the desktop user) set the display backlight.
rule='ACTION=="add", SUBSYSTEM=="backlight", RUN+="/bin/chmod 0666 /sys/class/backlight/%k/brightness"'
if [ "$(cat /etc/udev/rules.d/90-backlight.rules 2>/dev/null)" != "$rule" ]; then
  echo "$rule" | sudo tee /etc/udev/rules.d/90-backlight.rules >/dev/null
  sudo udevadm control --reload
  sudo udevadm trigger --subsystem-match=backlight --action=add
else
  echo "already configured"
fi

step "Touchscreen follows the rotated screen"
# The picture is turned to landscape by scripts/kiosk.sh each time the kiosk starts. For touches to
# land in the right place, the desktop (labwc) must be told the touchscreen belongs to that screen;
# it then applies the same rotation to touches. Real touches are passed to the app (no mouse
# emulation) so the maps can be pinched and dragged with fingers.
screen="$(ls /sys/class/drm 2>/dev/null | sed -n 's/.*\(DSI-[0-9]*\)$/\1/p' | head -1 || true)"
screen="${screen:-DSI-1}"
labwc_config="$HOME/.config/labwc/rc.xml"
touch_line="  <touch mapToOutput=\"$screen\" mouseEmulation=\"no\"/>"
mkdir -p "$(dirname "$labwc_config")"
if grep -q 'mapToOutput' "$labwc_config" 2>/dev/null; then
  echo "already configured"
else
  # Start from the system's own settings when the user has none, so nothing else is lost.
  if [ ! -f "$labwc_config" ]; then
    if [ -f /etc/xdg/labwc/rc.xml ]; then cp /etc/xdg/labwc/rc.xml "$labwc_config"
    else printf '<?xml version="1.0"?>\n<labwc_config>\n</labwc_config>\n' > "$labwc_config"; fi
  fi
  if grep -q '</labwc_config>' "$labwc_config"; then
    sed -i "s|</labwc_config>|$touch_line\n</labwc_config>|" "$labwc_config"
    echo "touchscreen mapped to $screen"
  else
    echo "WARNING: $labwc_config has an unexpected layout; add this line inside it by hand:" >&2
    echo "$touch_line" >&2
  fi
fi

step "Start-up screen"
# A plain splash while the system starts, in place of scrolling text. The panel is portrait, and the
# splash is drawn before anything can rotate the picture, so a copy of the image already turned
# to match is used: splashRotation in config.json if set, otherwise screenRotation.
set_splash=/usr/sbin/plymouth-set-default-theme   # not on an ordinary user's path
if [ -x "$set_splash" ]; then
  rotation="$(sed -n 's/.*"splashRotation": *\([0-9]*\).*/\1/p' "$REPO/config.json")"
  [ -n "$rotation" ] || rotation="$(sed -n 's/.*"screenRotation": *\([0-9]*\).*/\1/p' "$REPO/config.json")"
  image="$REPO/assets/splash-${rotation:-0}.png"
  [ -f "$image" ] || image="$REPO/assets/splash-0.png"
  splash_dir=/usr/share/plymouth/themes/flight-radar
  if ! cmp -s "$image" "$splash_dir/splash.png" || [ "$(sudo "$set_splash")" != flight-radar ]; then
    sudo mkdir -p "$splash_dir"
    sudo cp "$image" "$splash_dir/splash.png"
    printf '%s\n' '[Plymouth Theme]' 'Name=Flight Radar' 'Description=Radar splash for the flight radar display' 'ModuleName=script' '' \
      '[script]' "ImageDir=$splash_dir" "ScriptFile=$splash_dir/flight-radar.script" | sudo tee "$splash_dir/flight-radar.plymouth" >/dev/null
    # Fills the background with the image's own colour and shows the image centred, shrunk to fit if needed.
    printf '%s\n' \
      'Window.SetBackgroundTopColor(0.043, 0.086, 0.133);' \
      'Window.SetBackgroundBottomColor(0.043, 0.086, 0.133);' \
      'image = Image("splash.png");' \
      'scale = Math.Min(1, Math.Min(Window.GetWidth() / image.GetWidth(), Window.GetHeight() / image.GetHeight()));' \
      'image = image.Scale(image.GetWidth() * scale, image.GetHeight() * scale);' \
      'sprite = Sprite(image);' \
      'sprite.SetX(Window.GetX() + (Window.GetWidth() - image.GetWidth()) / 2);' \
      'sprite.SetY(Window.GetY() + (Window.GetHeight() - image.GetHeight()) / 2);' | sudo tee "$splash_dir/flight-radar.script" >/dev/null
    sudo "$set_splash" -R flight-radar   # -R rebuilds the start-up image, which takes a minute
    echo "splash installed ($(basename "$image"))"
  else
    echo "already installed"
  fi
  if command -v raspi-config >/dev/null; then
    sudo raspi-config nonint do_boot_splash 0   # show the splash, hide the start-up text
    # No rainbow square before the splash.
    grep -q '^disable_splash=1' /boot/firmware/config.txt 2>/dev/null || echo 'disable_splash=1' | sudo tee -a /boot/firmware/config.txt >/dev/null
  fi
else
  echo "skipped (plymouth is not installed)"
fi

step "Kiosk on boot"
if command -v raspi-config >/dev/null; then
  sudo raspi-config nonint do_boot_behaviour B4   # boot to desktop, logged in
  sudo raspi-config nonint do_blanking 1          # never blank the screen
  # The app has its own on-screen keyboards, so the system's is switched off (two would appear).
  sudo raspi-config nonint do_squeekboard S3 2>/dev/null || echo "note: could not switch off the system on-screen keyboard"
else
  echo "raspi-config not found (not Raspberry Pi OS): skipping autologin and screen-blanking settings"
fi
autostart="$HOME/.config/labwc/autostart"
mkdir -p "$(dirname "$autostart")"
if ! grep -qF "$REPO/scripts/kiosk.sh" "$autostart" 2>/dev/null; then
  echo "$REPO/scripts/kiosk.sh &" >> "$autostart"
else
  echo "already configured"
fi

step "One-command updates"
# Lets scripts/update.sh carry on by itself after the restart it needs. Runs only while an update
# is pending (the marker file exists); see scripts/update.sh.
state_dir=/boot/firmware; [ -d "$state_dir" ] || state_dir=/var/lib
unit="[Unit]
Description=Continue a Flight Radar update after the restart
ConditionPathExists=$state_dir/flight-radar-update.pending
Wants=network-online.target
After=network-online.target flight-radar-data.service

[Service]
Type=oneshot
User=$(id -un)
ExecStart=$REPO/scripts/update.sh --fetch

[Install]
WantedBy=multi-user.target"
if [ "$(cat /etc/systemd/system/flight-radar-update.service 2>/dev/null)" != "$unit" ]; then
  echo "$unit" | sudo tee /etc/systemd/system/flight-radar-update.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable flight-radar-update.service
else
  echo "already configured"
fi

step "Done"
echo "Local map:  http://localhost/tar1090/"
echo "Reboot to start the kiosk:  sudo reboot"
echo "Once everything is set up, protect it against power cuts:  scripts/protect.sh enable"
echo "Later, to update to the latest version:  scripts/update.sh"
