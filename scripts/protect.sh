#!/usr/bin/env bash
# Power-cut protection: makes the system read-only so the plug can be pulled at any time.
#
#   scripts/protect.sh enable    Run once everything is set up (Wi-Fi joined, Flightradar24 signed
#                                in, home position and theme chosen). Saves the current state as
#                                the defaults, creates the writable storage areas and their
#                                backups, and makes the rest of the system read-only. Takes effect
#                                after a reboot.
#   scripts/protect.sh disable   Makes the system writable again (for updates or changes), after a
#                                reboot. Run "enable" again afterwards; that also re-saves the defaults.
#   scripts/protect.sh status    Shows what is currently in force.
#
# Run as the desktop user (sudo is used where needed). See data-area.sh for the storage design.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT=/var/lib/flight-radar-data
ETC=/etc/flight-radar
NM_DIR=/etc/NetworkManager/system-connections
APP_DATA="$HOME/.config/flight-radar-display"   # where the app keeps everything when protection is off
SETTINGS_FILES="display.json location.json"

[ "$(id -u)" -ne 0 ] || { echo "Run as the desktop user, not root (sudo is used where needed)." >&2; exit 1; }

overlay_on() { findmnt -n -o FSTYPE / | grep -q overlay; }

# The defaults are a copy of the three areas as they are right now.
save_defaults() {
  echo "Saving the current state as the defaults"
  local settings_from="$APP_DATA" browser_from="$APP_DATA" wifi_from="$NM_DIR" file
  mountpoint -q "$ROOT/settings" && settings_from="$ROOT/settings/data"
  mountpoint -q "$ROOT/browser" && browser_from="$ROOT/browser/data"
  mountpoint -q "$ROOT/wifi" && wifi_from="$ROOT/wifi/data"

  sudo rm -rf "$ETC/defaults"
  sudo mkdir -p "$ETC/defaults/settings" "$ETC/defaults/wifi" "$ETC/defaults/browser"
  for file in $SETTINGS_FILES; do
    [ -f "$settings_from/$file" ] && sudo cp -a "$settings_from/$file" "$ETC/defaults/settings/"
  done
  if sudo test -d "$wifi_from"; then sudo cp -a "$wifi_from/." "$ETC/defaults/wifi/"; fi
  # The browser's data (which holds the Flightradar24 sign-in), minus the settings files and minus
  # caches, which are large and rebuilt on demand.
  if [ -d "$browser_from" ]; then
    sudo tar -C "$browser_from" -cf - \
      --exclude='./display.json' --exclude='./location.json' \
      --exclude='Cache' --exclude='Code Cache' --exclude='GPUCache' --exclude='DawnCache' \
      --exclude='DawnGraphiteCache' --exclude='DawnWebGPUCache' --exclude='GraphiteDawnCache' \
      --exclude='GPUPersistentCache' --exclude='CacheStorage' --exclude='ScriptCache' \
      --exclude='blob_storage' --exclude='Crashpad' --exclude='*.tmp' --exclude='lost+found' . |
      sudo tar -C "$ETC/defaults/browser" -xf -
  fi
  sudo chmod 700 "$ETC/defaults/wifi"
  echo "  $(sudo du -sh "$ETC/defaults" | cut -f1) saved in $ETC/defaults"
}

case "${1:-}" in
  enable)
    if overlay_on; then
      echo "Protection is already on, so nothing can be changed. Run: scripts/protect.sh disable, reboot, then enable again." >&2
      exit 1
    fi
    sudo mkdir -p "$ETC"
    id -un | sudo tee "$ETC/user" >/dev/null

    # Where the storage lives: a folder on the boot partition, unless told otherwise (for testing).
    store="${FLIGHT_RADAR_STORE:-/boot/firmware/flight-radar}"
    areas="${FLIGHT_RADAR_AREAS:-settings:16 wifi:16 browser:64}"   # name:size in MB
    store_parent="$(dirname "$store")"
    [ -d "$store_parent" ] || { echo "$store_parent does not exist; set FLIGHT_RADAR_STORE to a folder on a partition that stays writable." >&2; exit 1; }
    need_mb=0
    for area in $areas; do need_mb=$((need_mb + ${area##*:} * 3)); done   # each area plus its two backups
    sudo systemctl stop flight-radar-data.service 2>/dev/null || true   # frees any earlier storage before measuring
    save_defaults
    sudo rm -rf "$store"
    free_mb="$(df -Pm "$store_parent" | awk 'NR==2 {print $4}')"
    if [ "$free_mb" -lt $((need_mb + 10)) ]; then
      echo "Not enough room in $store_parent: ${need_mb} MB needed for the storage areas and their backups, ${free_mb} MB free. Set FLIGHT_RADAR_AREAS to smaller sizes." >&2
      exit 1
    fi
    printf 'STORE=%q\nAREAS=%q\n' "$store" "$areas" | sudo tee "$ETC/data-area.conf" >/dev/null

    echo "Setting up the storage areas"
    sudo tee /etc/systemd/system/flight-radar-data.service >/dev/null <<EOF
[Unit]
Description=Flight Radar storage (kept across power cuts; restored from backup or defaults if damaged)
DefaultDependencies=no
RequiresMountsFor=$store_parent
After=local-fs.target
Before=NetworkManager.service display-manager.service
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$REPO/scripts/data-area.sh
ExecStop=/bin/sh -c 'umount $NM_DIR 2>/dev/null; for area in settings wifi browser; do umount $ROOT/\$area 2>/dev/null; done; true'

[Install]
WantedBy=multi-user.target
EOF
    # A backup of one area, asked for by the app straight after something in it changes. There is
    # deliberately no scheduled backup: see data-area.sh.
    sudo tee /etc/systemd/system/flight-radar-backup@.service >/dev/null <<EOF
[Unit]
Description=Back up Flight Radar storage (%i)
Requires=flight-radar-data.service
After=flight-radar-data.service

[Service]
Type=oneshot
ExecStart=$REPO/scripts/data-area.sh backup %i
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable flight-radar-data.service
    sudo systemctl reset-failed flight-radar-data.service 2>/dev/null || true
    sudo systemctl start flight-radar-data.service
    sudo rm -f /run/flight-radar-data-restored   # freshly made storage is expected here, not a fault to report

    # Logs go to memory only and are capped, so they neither touch the card nor fill the memory.
    sudo mkdir -p /etc/systemd/journald.conf.d
    printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=16M\n' | sudo tee /etc/systemd/journald.conf.d/flight-radar.conf >/dev/null

    echo "Making the system read-only"
    if command -v raspi-config >/dev/null; then
      sudo raspi-config nonint do_overlayfs 0
      echo "Done. Reboot to finish:  sudo reboot"
    else
      echo "raspi-config not found (not Raspberry Pi OS): the storage is set up, but the system itself was NOT made read-only."
    fi
    ;;
  disable)
    if command -v raspi-config >/dev/null; then
      sudo raspi-config nonint do_overlayfs 1
      echo "The system will be writable after a reboot:  sudo reboot"
    else
      echo "raspi-config not found (not Raspberry Pi OS): nothing to switch off."
    fi
    ;;
  status)
    overlay_on && echo "System: read-only (protected)" || echo "System: writable (NOT protected)"
    for area in settings wifi browser; do
      if mountpoint -q "$ROOT/$area"; then
        echo "$area: in use, $(df -Ph "$ROOT/$area" | awk 'NR==2 {print $3 " of " $2 " used"}')"
      else
        echo "$area: not in use"
      fi
    done
    [ -f /run/flight-radar-data-restored ] && { echo "Restored at this start-up:"; sed 's/^/  /' /run/flight-radar-data-restored; }
    sudo test -d "$ETC/defaults" && echo "Defaults saved: $(sudo du -sh "$ETC/defaults" | cut -f1)"
    ;;
  *)
    echo "Usage: $0 enable|disable|status" >&2
    exit 1
    ;;
esac
