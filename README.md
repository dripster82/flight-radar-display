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
git clone <this repo> ~/flight-radar && cd ~/flight-radar
scripts/install.sh 51.5000 -0.1000   # home latitude and longitude (optional)
sudo reboot
```

The app then starts full screen on every boot and restarts itself if it crashes.

Flightradar24 feeding is a separate, deliberate step because it registers the receiver
and emails the account holder:

```sh
scripts/install-fr24.sh
```

## Settings

`config.json`: the two URLs, which tab opens first (`local` or `fr24`), `kiosk`, `home`, and
`zoom` (1.5 suits the 1280x720 Touch Display 2; use 1 on an 800x480 screen).
`LOCAL_RADAR_URL`, `KIOSK=1` and `HOME_LOCATION=lat,lon` override it from the environment.

`home` is what Flightradar24's "my location" button uses when there is no GPS fix, for example
`"home": { "latitude": 51.5, "longitude": -0.1 }`. With no GPS and no `home`, that button
cannot work: the browser has no other way to know where it is.
