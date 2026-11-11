# Hardware-day checklist

Everything in this project was built and tested on a Mac and in a Debian virtual machine. **None
of it has run on a real Raspberry Pi.** This page lists, in the order to do them, every part that
is unproven, the command that checks it, and what to do if it fails.

Work from the top: later checks depend on earlier ones. Run commands in a terminal on the Pi
(over SSH from the Mac is easiest: `ssh <user>@<pi-address>`).

## 1. Before switching on

| Check | How | If it fails |
|---|---|---|
| The plug supplies 5V at 3A | Read the rating printed on the plug | Use an official Raspberry Pi 4 supply |
| Screen ribbon cable seated at both ends | By eye; the latches are closed | Re-seat it; a loose ribbon gives a blank screen |
| Screen and fan each have a 5V and a ground pin | By eye, against the display's leaflet | See note 2 in `docs/hardware.md` |
| Card flashed with **Raspberry Pi OS 64-bit, with desktop** | In Raspberry Pi Imager; set the user name, Wi-Fi and SSH there | The Lite version has no desktop and the kiosk will not start |

## 2. First boot, before installing anything

| Check | Command | Expected | If it fails |
|---|---|---|---|
| 64-bit system | `uname -m` | `aarch64` | Re-flash with the 64-bit image |
| Power is adequate | `vcgencmd get_throttled` | `throttled=0x0` | Anything else means low voltage: change the plug or cable |
| The screen is seen | `ls /sys/class/drm \| grep DSI` | A line ending `DSI-1` (or `DSI-2`) | Check the ribbon; check `/boot/firmware/config.txt` has `display_auto_detect=1` |
| The touchscreen is seen | `sudo libinput list-devices \| grep -i -A1 touch` | A device with "touch" in its capabilities | Check the ribbon |
| The backlight can be controlled | `ls /sys/class/backlight/` | One entry | Brightness control will not work; tell Claude the output |
| sudo needs no password | `sudo -n true && echo ok` | `ok` | The app cannot start the feeder or request backups; see "Passwordless sudo" below |
| Room for the protected storage | `df -h /boot/firmware` | At least 300 MB available | Use smaller areas: see `FLIGHT_RADAR_AREAS` in `scripts/protect.sh` |

## 3. Install

```sh
git clone https://github.com/dripster82/flight-radar-display.git ~/flight-radar-display
cd ~/flight-radar-display
scripts/install.sh 53.9583 -1.0803      # your own latitude and longitude
sudo reboot
```

| Check | Command | Expected | If it fails |
|---|---|---|---|
| The install finished | Last lines of its output | `== Done` | Read the first error above it; the script can be run again |
| The app starts by itself after the reboot | Look at the screen | The app, full screen, within about a minute | `cat ~/.config/labwc/autostart` should name `scripts/kiosk.sh`; `raspi-config` > System > Boot must be "Desktop Autologin" |
| The app is running | `pgrep -fa vendor/electron \| head -1` | One line | Run `scripts/kiosk.sh` by hand over SSH with `WAYLAND_DISPLAY=wayland-0` set and read the error |

## 4. Screen and touch

| Check | How | Expected | If it fails |
|---|---|---|---|
| Picture is landscape and the right way up | Look | Tabs along the top | Upside down: set `"screenRotation": 270` in `config.json` and reboot. Still portrait: run `wlr-randr` over SSH (with `WAYLAND_DISPLAY=wayland-0`) and note the screen's name |
| A tap lands where you press | Tap each tab, then a plane | The thing under your finger responds | Taps land rotated or mirrored: check `~/.config/labwc/rc.xml` has the `<touch mapToOutput=.../>` line naming the same screen as `wlr-randr` shows. Taps do nothing at all: change `mouseEmulation="no"` to `"yes"` in that line and reboot |
| Two-finger pinch zooms the map | Pinch on "My receiver" | The map zooms | Only works with `mouseEmulation="no"`; if taps needed "yes", use the map's + and − buttons instead |
| Text and buttons are a comfortable size | Look | Finger-sized buttons | Change `"zoom"` in `config.json` (1.5 by default) |
| Brightness slider works | Settings > Brightness | The screen dims and brightens | `ls -l /sys/class/backlight/*/brightness` should show `rw-rw-rw-`; if not, re-run the install |
| Night dimming | Set the clock forward, or wait until 22:00 | Dims to 15% | Check `night` in `config.json` |
| The screen never blanks | Leave it 15 minutes | Still on | `sudo raspi-config nonint do_blanking 1` |
| Start-up shows the splash, not scrolling text | Reboot and watch | The radar splash the right way up, then the app | Sideways or upside down: set `"splashRotation"` in `config.json` to 270 (or 90, or 0) and re-run `scripts/install.sh`. Text still scrolls: `sudo raspi-config nonint do_boot_splash 0` |
| Welcome message shows once | Fill in `welcome` in `config.json`, restart | The message; a touch dismisses it and it does not return | Check `welcome` is not empty. To see it again: `scripts/protect.sh enable --show-welcome` (section 7) |

## 5. Receiver, GPS and map

| Check | Command or action | Expected | If it fails |
|---|---|---|---|
| Receiver stick is seen | `lsusb \| grep -i -e RTL -e Realtek` | One line | Try another USB port; avoid an unpowered hub |
| Decoder is running | `systemctl is-active readsb` | `active` | `journalctl -u readsb -n 30` |
| Aircraft are heard | `curl -s http://localhost/tar1090/data/aircraft.json \| grep -o '"hex"' \| wc -l` | More than 0 (near a window, antenna vertical) | Check the antenna cable; try outdoors |
| GPS has a fix | `gpspipe -w -n 8 \| grep -m1 '"mode":[23]'` | A line (can take several minutes from cold, near a window) | `systemctl is-active gpsd`; `ls /dev/ttyACM*` should show the GPS stick |
| Status chips are right | Look at the top bar | Receiver, GPS and Wi-Fi all green | Tap Settings for the detail |
| Map styles | Settings > Local map: try all four | Each loads | Dark needs the internet |
| Range rings | Look at the map | Rings at 20, 50, 100, 200 km | Re-run the install |
| H button | Tap H on the map | Recentres on the receiver | — |
| Radar scope is smooth | Settings > Local map > Radar scope; watch for a minute | An even sweep, no stutter | Tell Claude: the sweep can be made lighter. `top` shows the load |
| Map options | Settings > Local map: each switch | Labels, trails and larger aircraft appear | — |
| Temperature under load | `vcgencmd measure_temp` after 30 minutes on the radar scope | Under 70°C | Fit the fan from the cooling kit |

## 6. Wi-Fi and Flightradar24

| Check | Action | Expected | If it fails |
|---|---|---|---|
| Join a network from the touchscreen | Settings > Wi-Fi: pick one, type the password | "Connected" | `nmcli device wifi list` over SSH |
| Forget a network | Settings > Wi-Fi > Forget | It leaves the list | — |
| Flightradar24 loads and signs in | Flightradar24 tab; touch the e-mail box | The app's keyboard slides up under the page; typing, Enter and Hide work; sign-in succeeds | No keyboard: tell Claude which box (it may be inside a frame from another site). Meanwhile a USB keyboard works |
| Only one keyboard appears | Same | Just the app's keyboard, not a second one from the system | Two keyboards: `sudo raspi-config nonint do_squeekboard S3` (the system one off) and reboot |
| Return arrow | On the Flightradar24 tab, follow a link away from the site | An arrow appears beside the tab; touching it returns to Flightradar24 and the arrow goes | — |
| Back to start page | On the Flightradar24 tab, follow a link away from the site, then Settings > Flightradar24 > Back to start page | Back at the Flightradar24 start page | — |
| Sign out and start again | Settings > Flightradar24, tap twice | Flightradar24 opens signed out | — |
| The sign-in survives a restart | `sudo reboot` | Still signed in | Check the app's data folder is writable |
| "My location" on Flightradar24 | Tap its location button | Centres on the GPS (or home) position | — |

## 7. Power-cut protection

Do this only when everything above is right, the Wi-Fi is joined, Flightradar24 is signed in and
the theme is chosen: the state at this moment becomes the defaults.

```sh
sudo tests/storage-test.sh          # expect: 43 passed, 0 failed
scripts/protect.sh enable          # add --show-welcome on the very last time, before wrapping
sudo reboot
```

| Check | Command or action | Expected | If it fails |
|---|---|---|---|
| The storage test passes on the Pi | As above | `43 passed, 0 failed` | Send Claude the output; do not enable protection |
| The system is read-only | `scripts/protect.sh status` | `System: read-only (protected)` and three areas "in use" | `findmnt /` should show `overlay` |
| Settings survive a restart | Change the theme, wait 10 seconds, `sudo reboot` | The new theme | `systemctl status flight-radar-data` |
| A change is backed up | `journalctl -b \| grep flight-radar-data \| tail -3` after changing a setting | `settings: backup N written and checked` | Check passwordless sudo |
| The sign-in is backed up | Sign out and in on Flightradar24, then the same command | `browser: backup N written and checked` | Tell Claude: the site's sign-in cookie names may have changed |
| Pulling the plug is safe | Pull the plug while it is running, ten times, including once within 3 seconds of changing a setting | It starts normally every time; at worst the last change is lost and Settings says what was restored | Send Claude `journalctl -b \| grep flight-radar` |
| Nothing else was written | `touch ~/test-file`, reboot, `ls ~/test-file` | "No such file" | Protection is not on |

## 8. Updating

| Check | Command | Expected | If it fails |
|---|---|---|---|
| One-command update | `scripts/update.sh` | Restarts twice by itself and ends protected, on the new version, with settings, Wi-Fi and sign-in kept | `cat /boot/firmware/flight-radar-update.log` |

## 9. Flightradar24 feeder — last, and only when you are ready

This registers the receiver with Flightradar24. Leave it until the gift is otherwise finished.

```sh
scripts/protect.sh disable && sudo reboot      # the feeder cannot be installed while read-only
scripts/install-fr24.sh
```

| Check | Command or action | Expected | If it fails |
|---|---|---|---|
| Feeder status can be read | `curl -s http://127.0.0.1:8754/monitor.json \| head -c 300` | Text containing `feed_status` | Tell Claude the output: the app reads this to show the Feed chip |
| Feed chip | Look at the top bar, at home with a GPS fix | "Feeding" | Settings shows why it is waiting |
| Feed pauses away from home | Settings > "Set home to GPS position" somewhere else, or change `home` in `config.json` to a far-off position and restart | "Paused: away from home" | — |
| Protect again | `scripts/protect.sh enable && sudo reboot` | As section 7 | — |

## Passwordless sudo

The app uses `sudo` without a password for three things: starting and stopping the feeder,
requesting a backup after a change, and setting the receiver's position. Raspberry Pi OS allows
this for the first user by default. If `sudo -n true` asks for a password, it has been switched
off, and those three will silently do nothing.
