#!/usr/bin/env bash
# Installs the Flightradar24 feeder and runs its sign-up wizard.
#
# THIS REGISTERS THE RECEIVER and emails a sharing key to the address you enter.
# Run it only when the device is finished, using the FR24 account's email address.
# Run scripts/install.sh first so the decoder is already running.
set -euo pipefail

[ -x /usr/bin/readsb ] || { echo "Run scripts/install.sh first (readsb is not installed)." >&2; exit 1; }

cat <<'EOF'
The Flightradar24 wizard is about to start. Answers to give:

  Email address ........ the FR24 account's email
  Sharing key .......... leave blank (first time)
  MLAT ................. yes
  Latitude/longitude ... the home location, 4 decimal places
  Altitude ............. antenna height above sea level, in feet
  Receiver type ........ ModeS Beast (TCP)
  Host/port ............ 127.0.0.1:30005
  RAW / Basestation feeds: no

EOF
read -r -p "Register this receiver with Flightradar24 now? [y/N] " answer
[ "$answer" = "y" ] || { echo "Nothing done."; exit 0; }

wget -qO- https://fr24.com/install.sh | sudo bash -s
# The feeder must not start by itself at boot: the app starts it once GPS confirms the device is
# at home (see controlFeedFromGps in src/main.js). It is started now so the sign-up can be checked.
sudo systemctl disable fr24feed
sudo systemctl start fr24feed
echo
echo "Check the feed with:  fr24feed-status"
echo "From the next boot the feed starts only after the GPS shows the device is at home."
