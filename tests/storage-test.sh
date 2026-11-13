#!/usr/bin/env bash
# Proves the power-cut protection's storage logic (scripts/data-area.sh): backups, the checks made
# before anything is replaced, and what is restored after each kind of damage.
#
#   sudo tests/storage-test.sh [SANDBOX_DIR]
#
# Runs on any Debian-family Linux, including the Raspberry Pi itself. It is safe to run on a set-up
# device: everything happens inside a sandbox folder (default /var/tmp/flight-radar-test, about
# 75 MB, removed at the end) and the real storage, settings and Wi-Fi networks are never touched.
# "Power cuts" are imitated by overwriting files with random data while the storage is closed.
# Exits 0 when every check passes.
set -u

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
for tool in mkfs.ext4 e2fsck fsfreeze python3 sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 1; }
done

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/data-area.sh"
BOX="${1:-/var/tmp/flight-radar-test}"
STORE="$BOX/store"; ROOT="$BOX/mnt"; DEFAULTS="$BOX/defaults"; NM="$BOX/networks"; NOTE="$BOX/note"
LOG="$BOX/log"; CONF="$BOX/conf"; PEEK="$BOX/peek"
passed=0; failed=0

close_storage() {
  umount "$NM" 2>/dev/null
  for area in settings wifi browser cache log; do umount "$ROOT/$area" 2>/dev/null; done
  umount "$PEEK" 2>/dev/null
}
trap 'close_storage; rm -rf "$BOX"' EXIT
close_storage; rm -rf "$BOX"
mkdir -p "$STORE" "$ROOT" "$NM" "$PEEK" "$DEFAULTS/settings" "$DEFAULTS/wifi" "$DEFAULTS/browser/Partitions/fr24"
cat > "$CONF" <<EOF
STORE=$STORE
AREAS="settings:8 wifi:8 browser:8"
PLAIN_AREAS="cache:8 log:8"
ROOT=$ROOT
DEFAULTS=$DEFAULTS
NM_DIR=$NM
NOTE=$NOTE
OWNER=root
EOF

# What the device looked like when protection was switched on.
echo '{"brightness":80,"nightDim":true,"theme":"forest","mapStyle":"radar"}' > "$DEFAULTS/settings/display.json"
printf '[connection]\nid=HomeNet\n' > "$DEFAULTS/wifi/HomeNet.nmconnection"
echo signed-in-at-setup > "$DEFAULTS/browser/Partitions/fr24/Cookies"

# --- helpers -------------------------------------------------------------------------------------
section() { printf '\n%s\n' "$*"; }
check() { # description, then a command that must succeed
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then passed=$((passed + 1)); echo "  ok    $what"
  else failed=$((failed + 1)); echo "  FAIL  $what"; fi
}
is() { [ "$1" = "$2" ]; }                                   # is ACTUAL EXPECTED
script() { FLIGHT_RADAR_CONF="$CONF" "$SCRIPT" "$@" >> "$LOG" 2>&1; }
start_up() { close_storage; rm -f "$NOTE"; script; }        # what happens at every boot
backup() { script backup "$1"; }                            # what happens after a change
set_theme() { echo "{\"brightness\":80,\"nightDim\":true,\"theme\":\"$1\",\"mapStyle\":\"standard\"}" > "$ROOT/settings/data/display.json"; }
theme_in() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["theme"])' "$1/data/display.json" 2>/dev/null || echo unreadable; }
theme() { theme_in "$ROOT/settings"; }
networks() { ls "$NM" 2>/dev/null | grep -v lost | sed 's/.nmconnection//' | tr '\n' ' ' | sed 's/ $//'; }
sign_in() { cat "$ROOT/browser/data/Partitions/fr24/Cookies" 2>/dev/null || echo missing; }
note() { cat "$NOTE" 2>/dev/null; }
# A backup's generation number, or "invalid" when it is marked untrusted.
generation() { head -c 4096 "$STORE/$1-backup$2.ok" 2>/dev/null | tr -d '\0' | awk '{print ($1 == "sha256") ? $3 : $1}'; }
generations() { echo "$(generation "$1" 1)/$(generation "$1" 2)"; }
newest() { local a b; a="$(generation "$1" 1 | tr -dc 0-9)"; b="$(generation "$1" 2 | tr -dc 0-9)"; [ "${a:-0}" -ge "${b:-0}" ] && echo 1 || echo 2; }
older() { [ "$(newest "$1")" = 1 ] && echo 2 || echo 1; }
# The theme held inside a backup, read without changing it.
backup_holds() {
  mount -o loop,ro,noload "$STORE/settings-backup$1.img" "$PEEK" 2>/dev/null || { echo unmountable; return; }
  theme_in "$PEEK"; umount "$PEEK"
}
wreck() { dd if=/dev/urandom of="$1" bs=1M count=3 conv=notrunc status=none; }          # as if power went mid-write
half_written() { printf '%-4095s\n' invalid | dd of="$STORE/$1-backup$2.ok" bs=4096 count=1 conv=notrunc status=none; wreck "$STORE/$1-backup$2.img"; }
log_says() { grep -q "$1" "$LOG"; }

# --- the cases -----------------------------------------------------------------------------------
section "1. First start-up: three areas are made from the defaults, each with a first backup"
start_up
check "settings hold the default theme" is "$(theme)" forest
check "the saved Wi-Fi network is there" is "$(networks)" HomeNet
check "the sign-in is there" is "$(sign_in)" signed-in-at-setup
for area in settings wifi browser; do
  check "$area has a first backup" is "$(generation $area 1)" 1
  check "$area has a journal" sh -c "dumpe2fs -h '$STORE/$area.img' 2>/dev/null | grep -q has_journal"
done

section "2. Changes are backed up; two generations are kept"
set_theme day; backup settings; set_theme navy; backup settings
check "newest backup holds the latest change" is "$(backup_holds "$(newest settings)")" navy
check "older backup holds the one before" is "$(backup_holds "$(older settings)")" day

section "3. Start-up never writes a backup"
before="$(generations settings)"
start_up
check "plain restart: backups unchanged" is "$(generations settings)" "$before"
set_theme graphite; start_up
check "restart with a change not yet backed up: the change is kept" is "$(theme)" graphite
check "...and the backups are still unchanged" is "$(generations settings)" "$before"
check "no restore was reported" is "$(note)" ""

section "4. Power lost while the area was being changed"
close_storage; wreck "$STORE/settings.img"; start_up
check "restored from the newest backup" is "$(theme)" navy
check "a note says what was restored" sh -c "grep -q 'latest intact backup was restored' '$NOTE'"

section "5. Power lost while a backup was being written"
set_theme day; backup settings
spoiled="$(newest settings)"; kept="$(older settings)"; kept_generation="$(generation settings "$kept")"
close_storage; half_written settings "$spoiled"; start_up
check "the area itself is untouched" is "$(theme)" day
check "the half-written backup stays untrusted" is "$(generation settings "$spoiled")" invalid
check "the other backup still stands" is "$(generation settings "$kept")" "$kept_generation"
set_theme amber; backup settings
check "the next backup is written over the untrusted one" is "$(backup_holds "$spoiled")" amber
check "...not over the good one" is "$(generation settings "$kept")" "$kept_generation"

section "6. A backup half-written, and later the area wrecked too"
set_theme navy; backup settings          # older = amber, newer = navy
previous="$(backup_holds "$(older settings)")"
close_storage; half_written settings "$(newest settings)"; wreck "$STORE/settings.img"; start_up
check "restored from the previous backup" is "$(theme)" "$previous"

section "7. A settings file left half-written"
backup settings
echo '{"brightness":80,"the' > "$ROOT/settings/data/display.json"; start_up
check "restored from the newest backup" is "$(theme)" "$previous"

section "8. A bad area is never backed up"
before="$(generations settings)"
echo '{"brightness":80,"the' > "$ROOT/settings/data/display.json"
check "the backup is refused" sh -c "! FLIGHT_RADAR_CONF='$CONF' '$SCRIPT' backup settings"
check "both backups are unchanged" is "$(generations settings)" "$before"
set_theme day

section "9. The newest backup has silently gone bad on the card (its seal still claims it is fine)"
backup settings; set_theme navy; backup settings      # older = day, newer = navy
bad="$(newest settings)"; good="$(older settings)"; good_generation="$(generation settings "$good")"
dd if=/dev/urandom of="$STORE/settings-backup$bad.img" bs=4096 count=8 seek=300 conv=notrunc status=none
set_theme amber; backup settings
check "the bad backup is the one overwritten" is "$(backup_holds "$bad")" amber
check "the good older backup is kept" is "$(generation settings "$good")" "$good_generation"
check "...and still holds its contents" is "$(backup_holds "$good")" day

section "10. A new copy that fails its own check is not trusted"
standing="$(newest settings)"; standing_generation="$(generation settings "$standing")"; target="$(older settings)"
mkdir -p "$BOX/shim"   # a filesystem checker that rejects the read-only check of the new copy
printf '#!/bin/sh\ncase "$*" in *-fn*) exit 4;; esac\nexec %s "$@"\n' "$(command -v e2fsck)" > "$BOX/shim/e2fsck"; chmod +x "$BOX/shim/e2fsck"
set_theme graphite
check "the backup reports failure" sh -c "! PATH='$BOX/shim':\$PATH FLIGHT_RADAR_CONF='$CONF' '$SCRIPT' backup settings"
check "the new copy is left untrusted" is "$(generation settings "$target")" invalid
check "the previous backup stands" is "$(generation settings "$standing")" "$standing_generation"
backup settings
check "the next backup replaces the untrusted copy" is "$(backup_holds "$target")" graphite

section "11. The area and both its backups wrecked"
close_storage; for file in settings.img settings-backup1.img settings-backup2.img; do wreck "$STORE/$file"; done; start_up
check "settings go back to the defaults" is "$(theme)" forest
check "a note says the defaults were restored" sh -c "grep -q 'original defaults were restored' '$NOTE'"
check "a first backup is made, because none exists" is "$(generations settings)" 1/invalid
check "Wi-Fi was not affected" is "$(networks)" HomeNet
check "the sign-in was not affected" is "$(sign_in)" signed-in-at-setup

section "12. Each area stands alone"
printf '[connection]\nid=Hotel\n' > "$NM/Hotel.nmconnection"; backup wifi
set_theme day; backup settings
close_storage; wreck "$STORE/wifi.img"; start_up
check "Wi-Fi is restored from its own backup" is "$(networks)" "HomeNet Hotel"
check "settings were not affected" is "$(theme)" day
echo signed-in-again > "$ROOT/browser/data/Partitions/fr24/Cookies"; backup browser
close_storage; for file in browser.img browser-backup1.img browser-backup2.img; do wreck "$STORE/$file"; done; start_up
check "the sign-in goes back to the one from setup" is "$(sign_in)" signed-in-at-setup
check "settings and Wi-Fi were not affected" is "$(theme) $(networks)" "day HomeNet Hotel"

section "13. Every backup written was checked first"
check "the log shows backups written and checked" log_says "written and checked"

section "14. The web cache and the log: kept across restarts, no backups, remade empty if wrecked"
start_up
check "the cache area is open and writable" sh -c "echo page > '$ROOT/cache/data/page'"
check "the log area is open and writable" sh -c "echo line > '$ROOT/log/data/flight-radar.log'"
check "neither has a backup" sh -c "! ls '$STORE' | grep -Eq '^(cache|log)-backup'"
check "asking for a backup of the cache is refused" sh -c "! FLIGHT_RADAR_CONF='$CONF' '$SCRIPT' backup cache"
start_up
check "the cache is still there after a restart" is "$(cat "$ROOT/cache/data/page" 2>/dev/null)" page
check "the log is still there after a restart" is "$(cat "$ROOT/log/data/flight-radar.log" 2>/dev/null)" line
close_storage; wreck "$STORE/cache.img"; start_up
check "a wrecked cache comes back empty and writable" sh -c "[ ! -e '$ROOT/cache/data/page' ] && touch '$ROOT/cache/data/again'"
check "the log was not affected" is "$(cat "$ROOT/log/data/flight-radar.log" 2>/dev/null)" line
check "no restore note is raised for it" sh -c "[ ! -s '$NOTE' ]"
check "settings were not affected" is "$(theme)" day

printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ] || { echo "Log of what the storage script reported:"; sed 's/^/  /' "$LOG"; }
[ "$failed" -eq 0 ]
