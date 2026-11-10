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
  Wi-Fi on the Settings button. Green is working, red is not, amber means the feed is paused
  because the device is away from home, grey means that service is not present.
- **Settings**: screen brightness, night dimming, and Wi-Fi (join with the on-screen keyboard,
  rejoin a saved network with one tap, or forget one).

## Settings file

`config.json`:

| Key | Meaning |
|---|---|
| `localRadarUrl`, `fr24Url` | The two pages. The local map hides its sidebar and centres on the receiver. |
| `startTab` | `local` or `fr24`. |
| `home` | Home coordinates. Used for FR24's "my location" button when there is no GPS fix, and to decide when the device is away. With no GPS and no `home`, that button cannot work. |
| `awayKm` | Further than this from `home` (by GPS), the Flightradar24 feeder is stopped; it restarts when back. The feeder is registered at a fixed location, so it should not upload from elsewhere. |
| `night` | Hours during which the screen dims to `brightness` percent, when night dimming is on. |
| `zoom` | 1.5 suits the 1280x720 Touch Display 2; use 1 on an 800x480 screen. |
| `kiosk` | Full screen with no window frame. |

`LOCAL_RADAR_URL`, `KIOSK=1` and `HOME_LOCATION=lat,lon` override the file from the environment.
