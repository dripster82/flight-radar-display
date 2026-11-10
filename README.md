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
LOCAL_RADAR_URL=https://globe.adsb.lol/ npm start
```

## Install on the Pi

Raspberry Pi OS 64-bit Desktop, logged in as the desktop user, SDR and GPS plugged in:

```sh
git clone https://github.com/dripster82/flight-radar-display.git ~/flight-radar && cd ~/flight-radar
scripts/install.sh 51.5000 -0.1000   # home latitude and longitude (optional)
sudo reboot
```

The app then starts full screen on every boot and restarts itself if it crashes.

Flightradar24 feeding is a separate, deliberate step because it registers the receiver
and emails the account holder:

```sh
scripts/install-fr24.sh
```

## What is on screen

- **My Receiver / Flightradar24** tabs. Tapping the tab you are on returns it to its home view.
- **Status lights**: RX (receiver, with aircraft count), FEED (Flightradar24 upload), GPS, and
  Wi-Fi on the Settings button. Green is working, red is not, amber means the feed is being held back
  (waiting for a GPS fix at home, or paused because the device is away), grey means that service
  is not present.
- **Themes**: five colour themes (Navy, Graphite, Forest, Day, Amber) chosen in Settings. They
  restyle the tab bar and Settings; the two map pages are web sites and keep their own look.
- **Local map styles**: Standard, Dark, Satellite, and Radar scope, chosen in Settings. Radar scope
  replaces the map with a green wireframe of coastlines and borders on black, range rings, and a
  rotating sweep that lights each stretch of outline as it passes. The sweep is decoration: the
  receiver hears every aircraft continuously. Outline data: Natural Earth 1:50m (public domain).
- **Settings**: home position (reset it to the GPS position after moving house), whether the
  feed waits for GPS, screen brightness, night dimming, and Wi-Fi (join with the on-screen keyboard,
  rejoin a saved network with one tap, or forget one).

## Settings file

`config.json`:

| Key | Meaning |
|---|---|
| `localRadarUrl`, `fr24Url` | The two pages. The local map hides its sidebar and centres on the receiver. |
| `distanceUnits` | `km`, `miles` or `nautical`: the unit for distances on the local map, including the range rings. Altitude stays in feet and speed in knots. |
| `rangeRings` | Distances, in `distanceUnits`, of the range rings drawn around the receiver on the local map. |
| `startTab` | `local` or `fr24`. |
| `home` | Home coordinates. Settings > **Set home to GPS position** replaces this on the device (saved in the app's data folder, not this file); use it after moving house, once the location has been changed on the Flightradar24 website. Used for FR24's "my location" button when there is no GPS fix, and to decide when the device is away. With no GPS and no `home`, that button cannot work. |
| `awayKm` | How far from `home` (in km) still counts as at home; 5 by default. The Flightradar24 feeder is registered at a fixed location, so it only uploads from there. |
| `feedRequiresGps` | The starting value of the **Feed waits for GPS** switch in Settings; the switch then overrides it on the device. On: after boot the feeder stays off until five GPS fixes in a row place the device within `awayKm` of `home`, and it is stopped again if GPS places it further away. Off: the feeder starts at boot without waiting, and is still stopped if GPS shows the device is away. Turn it off if the GPS cannot get a fix where the device lives, or it will never feed. |
| `night` | Hours during which the screen dims to `brightness` percent, when night dimming is on. |
| `zoom` | 1.5 suits the 1280x720 Touch Display 2; use 1 on an 800x480 screen. |
| `kiosk` | Full screen with no window frame. |

`distanceUnits` and `rangeRings` are applied by `scripts/install.sh`; re-run it on the device after changing them.

`LOCAL_RADAR_URL`, `KIOSK=1` and `HOME_LOCATION=lat,lon` override the file from the environment.
