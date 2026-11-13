#!/usr/bin/env bash
# Updates the device to the latest version from GitHub with one command:
#
#   scripts/update.sh
#
# Run as the desktop user (over SSH is fine; the connection drops when the device restarts).
# Settings > Update now runs this same script (src/update.js).
#
# With power-cut protection on, the system is read-only, so an update cannot simply be installed.
# This script does the whole sequence by itself:
#   1. switches protection off and restarts;
#   2. after the restart: fetches the new version, runs scripts/install.sh, switches protection
#      back on (keeping the current settings, Wi-Fi networks and sign-in), and restarts again.
# Step 2 is started at boot by flight-radar-update.service (set up by scripts/install.sh), which
# runs only while the "update pending" marker exists. The marker and a log of what happened are
# kept on the boot partition, the one place that stays writable throughout.
#
# With protection off, it just fetches, installs and restarts the app; nothing restarts the device.
# If fetching the new version fails (no internet, or local changes that clash), the device is put
# back as it was, protected, on the version it already had.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR=/boot/firmware
[ -d "$STATE_DIR" ] || STATE_DIR=/var/lib      # not a Raspberry Pi (testing)
MARKER="$STATE_DIR/flight-radar-update.pending"
LOG="$STATE_DIR/flight-radar-update.log"

[ "$(id -u)" -ne 0 ] || { echo "Run as the desktop user, not root (sudo is used where needed)." >&2; exit 1; }

protected() { findmnt -n -o FSTYPE / | grep -q overlay; }
say() { echo "$*"; echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | sudo tee -a "$LOG" >/dev/null; }
version() { git -C "$REPO" log -1 --format='%h %s' 2>/dev/null; }

fetch() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do      # the network can take a while to come up after a restart
    if git -C "$REPO" pull --ff-only --autostash 2>&1 | sudo tee -a "$LOG"; then return 0; fi
    sleep 10
  done
  return 1
}

case "${1:-}" in
  "")
    sudo rm -f "$LOG"
    say "Update started. Now: $(version)"
    if protected; then
      echo "was_protected=1" | sudo tee "$MARKER" >/dev/null
      sudo raspi-config nonint do_overlayfs 1 || { say "Could not switch protection off; nothing changed."; sudo rm -f "$MARKER"; exit 1; }
      say "Protection switched off; restarting to continue the update."
      sudo reboot
    else
      echo "was_protected=0" | sudo tee "$MARKER" >/dev/null
      exec "$0" --fetch
    fi
    ;;

  --fetch)   # after the restart (or straight away when protection was off)
    [ -f "$MARKER" ] || { echo "No update is pending." >&2; exit 1; }
    if protected; then say "The system is still read-only, so the update cannot go on. Nothing changed."; sudo rm -f "$MARKER"; exit 1; fi
    if fetch; then say "Fetched. Now: $(version)"; else say "Could not fetch the new version; keeping the current one."; fi
    # The new version of this script takes over from here, in case this step itself was updated.
    exec "$REPO/scripts/update.sh" --install
    ;;

  --install)
    [ -f "$MARKER" ] || { echo "No update is pending." >&2; exit 1; }
    was_protected="$(sed -n 's/^was_protected=//p' "$MARKER")"
    if "$REPO/scripts/install.sh" 2>&1 | sudo tee -a "$LOG" >/dev/null; then say "Installed."; else say "The install step reported a problem; see above."; fi
    if [ "$was_protected" = 1 ]; then
      if "$REPO/scripts/protect.sh" enable 2>&1 | sudo tee -a "$LOG" >/dev/null; then
        say "Protection switched back on; restarting. Update finished: $(version)"
      else
        say "COULD NOT switch protection back on. The device works but is NOT protected: run scripts/protect.sh enable."
      fi
      sudo rm -f "$MARKER"
      sudo reboot
    else
      sudo rm -f "$MARKER"
      pkill -f "$REPO/vendor/electron/electron" || true   # scripts/kiosk.sh starts the new version
      say "Update finished: $(version)"
    fi
    ;;

  *)
    echo "Usage: $0" >&2
    exit 1
    ;;
esac
