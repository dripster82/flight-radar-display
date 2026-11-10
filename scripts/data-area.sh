#!/usr/bin/env bash
# Looks after the writable storage. Run as root:
#   data-area.sh                  at boot (flight-radar-data.service): check, restore if needed, open
#   data-area.sh backup <area>    after a change (flight-radar-backup@<area>.service), <area> or "all"
# Backups are made only after a change: never on a schedule and never at start-up, because every
# backup written is another chance to be caught by a power cut, and overwrites an older good one.
#
# Why this exists: with power-cut protection on (see protect.sh) the whole system is read-only, so
# pulling the plug cannot damage it. What must survive a restart is kept in three separate areas:
#   settings   the choices made on the Settings screen
#   wifi       saved Wi-Fi networks
#   browser    the Flightradar24 sign-in
# Each is its own pre-sized file on the boot partition with its own journaled filesystem, so a
# fault in one never touches the others, and writing to them never changes the boot partition's
# own structure.
#
# The danger is power going while something is being WRITTEN. So each area has two backup copies
# besides itself, and no two of the three are ever written at the same time:
#   1. A backup exists before the area is changed (the one made after the previous change).
#   2. The area is changed (by the app, the Wi-Fi screen or the browser).
#   3. A new backup is made, with the area frozen so it cannot change meanwhile. It overwrites the
#      OLDER of the two backups, so the most recent good backup is still there until the new one
#      is complete and sealed with its checksum.
# Nothing is trusted without being checked first, so a good backup is never replaced by a bad one:
#   - before step 3 the area must pass its checks, or no backup is made and both backups are kept;
#   - both existing backups are re-read against their checksums to decide which one may be
#     overwritten (one that fails, else the older);
#   - the new copy is sealed only after it has been read back from the card, matches the area
#     exactly, and its filesystem checks clean. Until then it is marked untrusted.
# Power lost during 2: the area may be bad; the latest backup is intact, so it is restored.
# Power lost during 3: the backup being written has no valid seal, so it is ignored; the area is
# checked, and if it is also bad the previous backup is restored.
# If the area and both backups are all unusable, the area is reformatted and refilled from the
# defaults on the read-only system (the state when protection was switched on).
# A note is left in /run so the app can say what was restored.
set -u

STORE=/boot/firmware/flight-radar
AREAS="settings:16 wifi:16 browser:64"            # name:size in MB
[ -f /etc/flight-radar/data-area.conf ] && . /etc/flight-radar/data-area.conf   # may override STORE and AREAS

ROOT=/var/lib/flight-radar-data
DEFAULTS=/etc/flight-radar/defaults
OWNER="$(cat /etc/flight-radar/user)"
NM_DIR=/etc/NetworkManager/system-connections
NOTE=/run/flight-radar-data-restored

log() { echo "flight-radar-data: $*"; }
names() { local a; for a in $AREAS; do echo "${a%%:*}"; done; }
bytes_of() { local a; for a in $AREAS; do [ "${a%%:*}" = "$1" ] && echo $(( ${a##*:} * 1024 * 1024 )); done; }
label() {
  case "$1" in
    settings) echo "Settings storage" ;;
    wifi) echo "Wi-Fi network storage" ;;
    browser) echo "Flightradar24 sign-in storage" ;;
    *) echo "$1" ;;
  esac
}
image() { echo "$STORE/$1.img"; }
slot() { echo "$STORE/$1-backup$2.img"; }
seal() { echo "$STORE/$1-backup$2.ok"; }
mount_of() { echo "$ROOT/$1"; }

# Files on the boot partition are made once at full size and afterwards only overwritten in place.
ensure_file() { # path, size in bytes
  if [ ! -f "$1" ] || [ "$(stat -c %s "$1")" -ne "$2" ]; then
    rm -f "$1"
    dd if=/dev/zero of="$1" bs=4096 count=$(($2 / 4096)) status=none
  fi
}
# A file's checksum as it is on the card, not as it may still be held in memory.
checksum() { { dd if="$1" bs=1M iflag=direct status=none 2>/dev/null || cat "$1"; } | sha256sum | cut -d' ' -f1; }
write_seal() { printf '%-4095s\n' "$2" | dd of="$1" bs=4096 count=1 conv=notrunc,fsync status=none; }

# A backup's seal holds "sha256 <checksum> <generation>". The backup is intact only when its
# contents still match that checksum. Prints "<generation> <checksum>" for an intact backup.
sealed() { # area, slot number
  local file kind sum generation
  file="$(slot "$1" "$2")"
  [ -f "$file" ] && [ -f "$(seal "$1" "$2")" ] || return 1
  read -r kind sum generation _ < <(head -c 4096 "$(seal "$1" "$2")" | tr -d '\0')
  [ "$kind" = sha256 ] && [ -n "$sum" ] && [ "$(checksum "$file")" = "$sum" ] || return 1
  echo "${generation:-0} $sum"
}

# The intact backups of an area, most recent first, as lines of "<slot> <generation> <checksum>".
intact_backups() {
  local n info
  for n in 1 2; do info="$(sealed "$1" "$n")" && echo "$n $info"; done | sort -k2,2nr
}

open_area() {
  mkdir -p "$(mount_of "$1")"
  # sync: every write goes to the card at once, so there is very little to lose if power goes.
  mount -o loop,noatime,sync "$(image "$1")" "$(mount_of "$1")"
}

# Usable when its data folder is there and writable and, for settings, every file parses.
usable() {
  local data file
  data="$(mount_of "$1")/data"
  [ -d "$data" ] || return 1
  touch "$data/.write-test" 2>/dev/null && rm -f "$data/.write-test" || return 1
  [ "$1" = settings ] || return 0
  for file in "$data"/*.json; do
    [ -e "$file" ] || continue
    python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$file" 2>/dev/null || { log "corrupt settings file: $(basename "$file")"; return 1; }
  done
}

# Step 3 above.
backup() {
  local area="$1" at latest target generation copied source copy
  at="$(mount_of "$area")"
  mountpoint -q "$at" || { log "$area: not open, nothing to back up"; return 1; }
  # A bad area must never replace a good backup.
  usable "$area" || { log "$area: failed its checks, so it was NOT backed up; both backups are kept as they are"; return 1; }
  # Re-read both backups against their checksums. Write over one that is not intact, or else the
  # older one. Never the most recent good one.
  latest="$(intact_backups "$area" | head -1)"
  target=1
  [ -n "$latest" ] && [ "${latest%% *}" = 1 ] && target=2
  generation=$(( $(echo "${latest:-0 0}" | awk '{print $2}') + 1 ))
  ensure_file "$(slot "$area" "$target")" "$(bytes_of "$area")"
  ensure_file "$(seal "$area" "$target")" 4096

  fsfreeze -f "$at" || { log "$area: could not be frozen; backup skipped"; return 1; }
  trap "fsfreeze -u '$at' 2>/dev/null" EXIT
  write_seal "$(seal "$area" "$target")" "invalid"    # not to be trusted until it has been checked
  dd if="$(image "$area")" of="$(slot "$area" "$target")" bs=1M conv=notrunc,fsync status=none; copied=$?
  source="$(checksum "$(image "$area")")"
  fsfreeze -u "$at"
  trap - EXIT

  # Check the new copy before trusting it: read back from the card it must match the area exactly,
  # and its filesystem must be clean. Otherwise it stays untrusted and the other backup stands.
  [ "$copied" -eq 0 ] || { log "$area: backup could not be written; the previous backup stands"; return 1; }
  copy="$(checksum "$(slot "$area" "$target")")"
  [ -n "$source" ] && [ "$copy" = "$source" ] || { log "$area: the new backup does not match the area; discarded, the previous backup stands"; return 1; }
  e2fsck -fn "$(slot "$area" "$target")" >/dev/null 2>&1 || { log "$area: the new backup failed its filesystem check; discarded, the previous backup stands"; return 1; }
  write_seal "$(seal "$area" "$target")" "sha256 $copy $generation" || return 1
  log "$area: backup $generation written and checked"
}

from_backup() { # area, slot number
  dd if="$(slot "$1" "$2")" of="$(image "$1")" bs=1M conv=notrunc,fsync status=none || return 1
  e2fsck -p "$(image "$1")" >/dev/null 2>&1
  [ $? -lt 4 ] && open_area "$1" && usable "$1"
}

from_defaults() {
  local at data
  at="$(mount_of "$1")"; data="$at/data"
  mkfs.ext4 -q -F -m 0 -L "fr-$1" "$(image "$1")" || { log "$1: could not format"; return 1; }
  open_area "$1" || { log "$1: could not open the new area"; return 1; }
  mkdir -p "$data"
  [ -d "$DEFAULTS/$1" ] && cp -a "$DEFAULTS/$1/." "$data/"
  if [ "$1" = wifi ]; then
    chown -R root:root "$data"; chmod 700 "$data"; find "$data" -type f -exec chmod 600 {} +
  else
    chown -R "$OWNER": "$data"
  fi
  sync
}

# Replaces a bad area: the latest intact backup, else the previous one, else the defaults.
recover() { # area, what was wrong
  local area="$1" why="$2" n which="latest intact"
  umount "$(mount_of "$area")" 2>/dev/null
  ensure_file "$(image "$area")" "$(bytes_of "$area")"
  for n in $(intact_backups "$area" | cut -d' ' -f1); do
    if from_backup "$area" "$n"; then
      log "$area $why; restored from the $which backup"
      echo "$(label "$area") $why, so its $which backup was restored. Anything changed after that backup has been lost." >> "$NOTE"
      return 0
    fi
    umount "$(mount_of "$area")" 2>/dev/null
    which="remaining"
  done
  # Nothing saved can be trusted: start again from the defaults and discard both backups.
  for n in 1 2; do [ -f "$(seal "$area" "$n")" ] && write_seal "$(seal "$area" "$n")" "invalid"; done
  if from_defaults "$area"; then
    log "$area $why; no usable backup, rebuilt from the defaults"
    echo "$(label "$area") $why and neither backup could be used, so its original defaults were restored." >> "$NOTE"
  fi
}

check_and_open() {
  local area="$1" result
  if ! mountpoint -q "$(mount_of "$area")"; then
    if [ ! -f "$(image "$area")" ]; then
      recover "$area" "was missing"
    else
      e2fsck -p "$(image "$area")" >/dev/null 2>&1
      result=$?   # 0 = clean, 1 or 2 = problems found and repaired, 4 and above = could not be repaired
      if [ "$result" -ge 4 ]; then recover "$area" "was damaged and could not be repaired"
      elif ! open_area "$area"; then recover "$area" "could not be opened"
      elif ! usable "$area"; then recover "$area" "was incomplete or corrupt"
      fi
    fi
    # No backup is made at start-up as a rule: the last shutdown may have been a power cut, and an
    # area that passes the checks above could still be subtly wrong. Copying it now would overwrite
    # a known-good backup with it. The one exception is an area with no intact backup at all (just
    # created, or just rebuilt from the defaults), which needs its first one.
    if mountpoint -q "$(mount_of "$area")" && [ -z "$(intact_backups "$area")" ]; then backup "$area"; fi
  fi
  mountpoint -q "$(mount_of "$area")"
}

if [ "${1:-}" = backup ]; then
  status=0
  for area in $( [ "${2:-all}" = all ] && names || echo "$2" ); do
    [ -n "$(bytes_of "$area")" ] || { log "unknown area: $area"; status=1; continue; }
    backup "$area" || status=1
  done
  exit "$status"
fi

mkdir -p "$STORE"
status=0
for area in $(names); do
  check_and_open "$area" || { log "$area: unavailable; it will run on defaults and forget changes at power-off"; status=1; }
done

# Saved Wi-Fi networks are read by the system from here, so a network joined on holiday is remembered.
if mountpoint -q "$(mount_of wifi)" && [ -d "$NM_DIR" ] && ! mountpoint -q "$NM_DIR"; then
  mount --bind "$(mount_of wifi)/data" "$NM_DIR"
fi
[ "$status" -eq 0 ] && log "ready"
exit "$status"
