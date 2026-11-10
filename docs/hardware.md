# Parts list

Updated 10 November 2026. Target: finished by 10 December 2026.

| Part | Model | Price | Price checked |
|---|---|---|---|
| Computer | Raspberry Pi 4 Model B, 3GB | £80.40 | Not rechecked (from the original plan) |
| Screen | [Raspberry Pi Touch Display 2 - 7"](https://thepihut.com/products/raspberry-pi-touch-display-2) | £57.60 | 10 Nov, The Pi Hut — **sold out** that day |
| Enclosure | [OneNineDesign enclosure for Touch Display 2 (7")](https://thepihut.com/products/enclosure-for-raspberry-pi-touch-display-2-7), black or white | £9.90 | 10 Nov, in stock |
| Cooling | [Cooling Kit for Raspberry Pi 4](https://thepihut.com/products/cooling-kit-for-raspberry-pi-4) (heatsinks + optional 5V fan) | £4.00 | 10 Nov, in stock |
| ADS-B receiver | Nooelec NESDR SMArt v5 | £41.95 | Not rechecked |
| Antenna | NooElec ADS-B Discovery 3dBi bundle (1090 MHz) | £16.72 | Not rechecked |
| Antenna extension | Boobrie 15cm SMA bulkhead cables, pack of 2 | £6.95 | Not rechecked — may no longer be needed, see below |
| GPS | Stemedu VK-172 USB GPS/GLONASS | £13.90 | Not rechecked |
| **Subtotal** | | **£231.42** | |

Still to choose: power supply (official Raspberry Pi 4 USB-C, 5.1V 3A) and a 32GB or 64GB
high-endurance microSD card.

Replaced: the Freenove 7" 800x480 touchscreen (£38.95) and the plan for a custom 3D-printed
enclosure.

## What the new screen changes

- **Resolution is 1280x720** in landscape (the panel is natively 720x1280 portrait and is rotated
  in software). The app zooms its pages by 1.5 (`zoom` in `config.json`) so buttons stay finger-sized.
- **Connection:** one DSI ribbon cable plus power from the Pi's GPIO pins. No separate supply.
- **Mounting:** the Pi screws to the back of the display; the enclosure wraps both.

## Open questions with these parts

1. **Where the receiver, GPS and antenna go.** The enclosure holds only the screen and the Pi.
   The SDR and GPS are USB sticks, so they will stick out of the Pi's USB ports at the side unless
   put on short USB extension leads behind the unit. There is no panel to mount the SMA bulkhead
   connector on without drilling the enclosure, so the antenna either screws straight onto the SDR
   or the enclosure is modified.
2. **Whether the cooling kit's fan fits.** The enclosure listing says add-ons over about 20mm tall
   are blocked by the display's standoffs. The heatsinks alone should be fine; the fan on top of the
   large heatsink needs measuring.
3. **Fan and display both want GPIO power.** Each takes a 5V and a ground pin. The Pi has two 5V
   pins, so both can be connected, but check the display's power cable leaves the second one free.
4. **Screen rotation and touch on the Pi.** Landscape rotation has to be set in software and the
   touch input rotated to match. Not yet set up in `scripts/install.sh`.
5. **Stock.** The screen was sold out at The Pi Hut on 10 November; check other UK resellers.
