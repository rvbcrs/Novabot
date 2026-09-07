# RTK Walker

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/rvbcrs)

Handheld surveyor for marking the boundary of a lawn at cm-level
accuracy, then importing the result as a work-map polygon in the
OpenNova admin.

## Hardware

| Part | Notes |
|------|-------|
| ESP32-S3-N16R8 dev board | 16 MB flash + 8 MB octal PSRAM. USB-C native, dual core, plenty of GPIO. |
| Quectel LC29HDA | Dual-band L1/L5 RTK rover, 1 Hz NMEA output, accepts RTCM 3.x corrections. 3.3 V only. |
| Active GNSS antenna | Quectel ships a stock helical with the eval board. For walking accuracy a small ground-plane survey antenna helps. |
| USB-C cable + power bank | Power. The walker draws ~150 mA peak. |
| Optional: button cap, lanyard | For the BOOT-pin recording toggle. |

## Wiring

LC29HDA breakout pins → ESP32-S3 DevKitC-1:

```
 LC29HDA            ESP32-S3
 ─────────          ────────────────
  VCC  ──────────►  3V3
  GND  ──────────►  GND
  TX   ──────────►  GPIO 18   (UART1 RX)
  RX   ◄──────────  GPIO 17   (UART1 TX)
  PPS  (unused)
```

⚠️ **3.3 V only.** Do not feed the LC29HDA from the ESP32's 5 V rail
or USB Vbus — the module's I/O is 3.3 V-tolerant only and the power
pin expects a 3.3 V LDO output.

Antenna SMA pigtail straight into the LC29HDA's antenna pad. Walk
outdoors with a clear sky view (the same constraints as a Novabot
station: no leafy canopy, no glass, no metal within 30 cm of the
antenna top).

The BOOT button on the ESP32-S3 dev board doubles as the
start/stop-recording toggle — no extra wiring required.

## Build & flash

Two targets share the same source tree:

| Env | Hardware | UI |
|-----|----------|----|
| `esp32s3-walker`     | ESP32-S3-N16R8 dev board, no display | Web only (phone is the screen) |
| `jc3248w535-walker`  | JC3248W535EN (3.5" 320×480 TFT + touch) | Standalone touch UI **and** the same web UI |

```bash
pio run -e esp32s3-walker      -t upload    # headless variant
pio run -e jc3248w535-walker   -t upload    # with TFT
pio device monitor -b 115200
```

The same USB-C cable handles flashing and the runtime serial monitor
(`ARDUINO_USB_CDC_ON_BOOT=1`).

### TFT variant — what's on the screen

- **Status + map** (default). Top bar with RTK fix pill, sat count,
  HDOP, NTRIP up/down, current WiFi IP. Centre is a live-auto-zooming
  polyline of the track you're walking, with a coloured cursor for
  fix quality (emerald=RTK FIX, amber=FLOAT, blue=GPS). Bottom row
  has Start/Stop recording, Tracks, Settings.
- **Saved tracks**. List of CSVs on flash with point count + size, and
  the IP to download them from in a browser. Download itself still
  happens through the web UI — easier than offering files to a phone
  off a USB MSC mount.
- **Settings**. Tabbed WiFi + NTRIP forms with a soft keyboard. Saving
  reboots so the new credentials take effect. Existing passwords are
  preserved if you leave the field empty.

The GNSS + NTRIP backend is shared between both targets, so a TFT
device's `/api/*` endpoints behave identically to the headless one —
you can still walk a route with a phone if you'd rather.

## First-time setup

1. Power the walker. If no WiFi credentials are stored yet, it boots
   into an AP named **`rtk-walker-setup`** (password `rtkwalker`).
2. Connect your phone to that AP and open
   <http://192.168.4.1>.
3. In the *WiFi & NTRIP setup* card, fill in:
   - **WiFi SSID + password** — your home network so the device can
     reach the internet.
   - **NTRIP host**: `caster.centipede.fr`
   - **NTRIP port**: `2101`
   - **NTRIP mountpoint**: the code of the Centipede base station
     nearest to your garden. Pick from
     <https://docs.centipede.fr/docs/3.basestation/list/>; for the
     Netherlands the common picks are `NLAMS00FRA0` (Amsterdam) or
     `NLBRU00FRA0` (Bruinisse).
   - **NTRIP user / password**: `centipede` / `centipede` (the free
     public account; substitute your own if you signed up).
4. Save & reboot. The device joins your WiFi and starts streaming
   RTCM into the LC29HDA. Open the device's WiFi IP (printed on the
   serial monitor at boot) to see the live status page.

## Walking a boundary

1. Wait until the *Fix* pill turns green (`RTK FIX`, fix code 4). If
   it stays yellow (`RTK FLOAT`, code 5) or grey (`GPS`, code 1) the
   accuracy is degraded — find a clearer sky view.
2. Tap **Start recording** in the web UI, or press the BOOT button on
   the device.
3. Walk the boundary. The CSV captures one row per GGA fix the
   receiver produces (1 Hz default).
4. Tap **Stop recording** (or press BOOT again) when you're back at
   the starting point.
5. Download the CSV under *Saved tracks* and import it into the
   OpenNova admin's *Maps → Import polygon CSV* tool.

## Output format

`timestamp_unix,lat,lng,alt_m,fix,sats,hdop`

- `timestamp_unix` — seconds since 1970-01-01 UTC.
- `lat`, `lng` — decimal degrees, 7-digit precision (≈ 1 cm).
- `alt_m` — metres above the WGS-84 ellipsoid.
- `fix` — 0 no fix, 1 GPS, 2 DGPS, 4 RTK FIX, 5 RTK FLOAT.
- `sats` — satellites used in the solution.
- `hdop` — horizontal dilution of precision.

The OpenNova admin's polygon-import endpoint reads the first two
fields (`lat`, `lng`) and ignores the rest, so the CSV is a drop-in.

## Status LEDs

The dev board's onboard RGB LED is reserved for a future status
indicator (red = no fix, yellow = float, green = fix). v1 keeps it
off and relies on the web UI to surface fix quality, since the phone
is the intended display.

## Roadmap

- Replace the WiFi NTRIP client with a LoRa receiver so the walker
  can pull corrections directly from the Novabot charging station's
  base. The charger already broadcasts RTCM over LoRa to its own
  mower — we'd just need a second LoRa transceiver on the walker.
- Optional small OLED for fix status when phone access isn't
  practical.
- Battery monitor + auto-sleep when no movement for N minutes.
- Direct upload to the OpenNova server (POST the recorded polygon to
  `/api/admin-status/maps/:sn/import-polygon`) instead of CSV
  round-trip via the phone.
