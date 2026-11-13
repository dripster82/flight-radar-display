# Flight Radar Display

A 7-inch touchscreen flight radar on a Raspberry Pi 4. Two tabs:

- **My Receiver** — the aircraft this device hears itself (readsb + tar1090).
- **Flightradar24** — the real FR24 site, logged in.

## Run on a Mac (development)

```sh
npm install
npm start
```

With no receiver, the first tab shows a "not available yet" notice. To see a live map instead:

```sh
npm run start:test     # the public map at globe.adsb.lol stands in for the receiver, with a set home location (York)
npm run start:fresh    # the same, from an empty data folder: no settings or sign-in, as on a first start
```

## Install on the Pi

Raspberry Pi OS 64-bit Desktop, logged in as the desktop user, SDR and GPS plugged in:

```sh
git clone https://github.com/dripster82/flight-radar-display.git ~/flight-radar && cd ~/flight-radar
scripts/install.sh
sudo reboot
```

The app then starts full screen on every boot and restarts itself if it crashes. Set the home
position in Settings, from a postcode or from the GPS.

Flightradar24 feeding is a separate, deliberate step because it registers the receiver
and emails the account holder:

```sh
scripts/install-fr24.sh
```

## Power-cut protection

So the plug can be pulled at any time without harm, the system can be made read-only. Do this
last, once Wi-Fi is joined, Flightradar24 is signed in, and the home position and theme are chosen:

```sh
scripts/protect.sh enable
sudo reboot
```

- **The system** becomes read-only: nothing written while it runs reaches the SD card, so a power
  cut cannot corrupt it.
- **Three small storage areas** stay writable, one each for the Settings choices, the saved Wi-Fi
  networks, and the Flightradar24 sign-in. Each is its own pre-sized file on the boot partition
  with its own journaled filesystem, so a fault in one never touches the others.
- **Two backups of each area.** A backup always exists before an area is changed. A new backup is
  made within seconds of a change, and only then: when Settings are changed, when a Wi-Fi network
  is joined or forgotten, and when the Flightradar24 sign-in changes (signing in or out). Nothing
  is backed up on a schedule or at start-up, because every backup overwrites an older good one
  and is one more moment for a power cut to land in.
- **Everything is checked before anything is replaced.** The area must pass its checks or no
  backup is made. Both existing backups are re-read against their checksums, and the new backup
  overwrites one that fails, or else the older; never the most recent good one. The area is
  frozen while it is copied, so the area and its backups are never being written at the same
  moment. The new copy is trusted only after it has been read back from the card, matches the
  area exactly, and its filesystem checks clean; otherwise it is discarded and the previous
  backup stands.
- **Defaults** are a copy of all three areas as they were when protection was switched on, kept
  on the read-only system and never written again.
- **Auto-restore:** at every start-up each area is checked. One that is missing, damaged beyond
  repair, unwritable, or (for settings) holds a corrupt file is replaced by its most recent intact
  backup, or the previous one if that is not intact. If neither can be used, that area alone is
  reformatted and refilled from the defaults. Settings shows a notice saying what was restored.

| Power is lost while... | At the next start-up |
|---|---|
| nothing is being written | Everything is as it was |
| an area is being changed | That area is restored from its most recent backup if it was damaged |
| a backup is being written | The half-written backup is ignored (the other backup still stands) and is replaced at the next change; the area itself was not being written |
| both of the above, on different occasions | The previous backup is used |

The storage logic has its own test, which imitates each of these power cuts and checks what is
restored. It works in a sandbox folder, so it is safe to run on a set-up device:

```sh
sudo tests/storage-test.sh
```

## Updating

```sh
scripts/update.sh
```

One command fetches the latest version from GitHub and installs it. With power-cut protection on
it does the whole sequence by itself: switches protection off, restarts, updates, switches
protection back on (keeping the current settings, Wi-Fi networks and sign-in) and restarts again.
If the new version cannot be fetched, the device is put back as it was. What happened is logged in
`/boot/firmware/flight-radar-update.log`.

To change the system by hand instead: `scripts/protect.sh disable`, reboot, make the change, then
`scripts/protect.sh enable` again (which also re-saves the defaults). `scripts/protect.sh status`
shows what is in force.

## Start-up screen and welcome message

- **Splash:** `scripts/install.sh` replaces the start-up text with a plain radar splash
  (`assets/splash.svg`). The panel is portrait and the splash is drawn before anything can rotate
  the picture, so a pre-turned copy is used, chosen by `splashRotation` (or `screenRotation`).
- **Welcome message:** if `welcome` in `config.json` has a title or message, it is shown once over
  the whole screen at the first start, and a touch dismisses it for good. To have it shown again
  (for the last set-up before the device is wrapped): `scripts/protect.sh enable --show-welcome`.

## What is on screen

- **My Receiver / Flightradar24** tabs. Tapping the tab you are on returns it to its home view.
- **Return arrow** (beside the Flightradar24 tab): appears only while that tab is showing some
  other website, and takes it back to Flightradar24.
- **Flightradar24 reset** (in Settings): **Back to start page** is the way out if Flightradar24 is
  stuck on a sign-in page or has wandered off to another site. **Sign out and start again** also
  forgets the sign-in and everything else the site has stored.
- **On-screen keyboard for web pages**: touching a text box on either map tab (the Flightradar24
  sign-in or its search box, say) brings up a keyboard under the page; the page shrinks to make
  room. **Enter** submits, **Hide** puts it away, and touching the box again brings it back.
- **Status lights**: RX (receiver, with aircraft count), FEED (Flightradar24 upload), GPS, and
  Wi-Fi on the Settings button. Green is working, red is not, amber means the feed is being held back
  (waiting for a GPS fix at home, or paused because the device is away), grey means that service
  is not present.
- **Themes**: five colour themes (Navy, Graphite, Forest, Day, Amber) chosen in Settings. They
  restyle the tab bar and Settings; the two map pages are web sites and keep their own look.
- **Local map styles**: Radar scope (the default), Standard, Dark and Satellite, chosen in Settings. Radar scope
  replaces the map with a green wireframe of coastlines and borders on black, range rings, and a
  rotating sweep that lights each stretch of outline as it passes. The sweep is decoration: the
  receiver hears every aircraft continuously. Outline data: Natural Earth 1:50m (public domain).
- **Map extras**: three switches in Settings (**Map shows**) add callsign labels, the trail each
  aircraft has flown, and larger aircraft symbols to the local map.
- **Location**: **Home** is a pin, set in Settings from a UK postcode (looked up once over Wi-Fi at
  postcodes.io) or from the GPS position. While the GPS is within 2 miles of the pin, the pin itself
  is the position used for the map centre, range rings and "my location", so nothing drifts at
  home. Further away, the GPS position is used and held still; it only moves on once the GPS is more
  than 2 miles from the held position. **Use GPS position now** takes the GPS position at once
  while away (on holiday, say) without moving the home pin. With no GPS fix the last position stays
  in use. Each move restarts the decoder, and the local map shows "Repositioning, locating
  aircraft…" for a few seconds.
- **Settings**: the home pin and location, whether the feed waits for GPS, screen brightness, night dimming, and Wi-Fi (join with the on-screen keyboard,
  rejoin a saved network with one tap, or forget one).

## Settings file

`config.json`:

| Key | Meaning |
|---|---|
| `localRadarUrl`, `fr24Url` | The two pages. The local map hides its sidebar and centres on the receiver. |
| `distanceUnits` | `km`, `miles` or `nautical`: the unit for distances on the local map, including the range rings. Altitude stays in feet and speed in knots. |
| `rangeRings` | Distances, in `distanceUnits`, of the range rings drawn around the receiver on the local map. |
| `startTab` | `local` or `fr24`. |
| `home` | The starting home pin (`latitude`, `longitude`): the centre of Filey, so a new device has somewhere to centre its map. Settings > **Set by postcode** or **Set home to GPS position** sets it on the device (saved in the app's data folder, not this file). After moving house, change the location on the Flightradar24 website first. |
| `awayKm` | The location radius in km; 3.2 (2 miles) by default. Within it of the home pin counts as at home, and away from home the position only follows the GPS once it has moved further than this. The Flightradar24 feeder is registered at a fixed location, so it only uploads at home. |
| `feedRequiresGps` | The starting value of the **Feed waits for GPS** switch in Settings; the switch then overrides it on the device. On: after boot the feeder stays off until five GPS fixes in a row place the device within `awayKm` of `home`, and it is stopped again if GPS places it further away. Off: the feeder starts at boot without waiting, and is still stopped if GPS shows the device is away. Turn it off if the GPS cannot get a fix where the device lives, or it will never feed. |
| `night` | Hours during which the screen dims to `brightness` percent, when night dimming is on. |
| `zoom` | 1.5 suits the 1280x720 Touch Display 2; use 1 on an 800x480 screen. |
| `screenRotation` | 90 or 270 turns the portrait Touch Display 2 to landscape (whichever way up the enclosure holds it); 0 leaves the picture alone. Applied each time the kiosk starts. |
| `splashRotation` | Optional. The same for the start-up splash, if it comes out the other way up from the app. Re-run `scripts/install.sh` after changing it. |
| `welcome` | `title` and `message` shown once at the first start; leave both empty for none. |
| `kiosk` | Full screen with no window frame. |

`distanceUnits` and `rangeRings` are applied by `scripts/install.sh`; re-run it on the device after changing them.

`LOCAL_RADAR_URL`, `KIOSK=1` and `HOME_LOCATION=lat,lon` override the file from the environment.
