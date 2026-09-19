# Notifications & Push

OpenNova detects state changes on your mower and fans them out to multiple channels in parallel. Pick whichever channels suit you — they're independently configured via environment variables and any combination works.

## What gets detected

The notification dispatcher watches your mower's MQTT reports and emits a typed event whenever a meaningful state transition occurs. Events are NOT polled — they fire the moment the underlying sensor field changes, so the latency between mower-event and phone-buzz is roughly the broker round-trip (sub-second).

| Event | Trigger | Default body |
|---|---|---|
| `mowing_started` | `msg` enters `Work:RUNNING` / `COVERING` / `NAVIGATING` / `BOUNDARY_COVERING` / `AVOIDING` | full `msg` field |
| `mowing_finished` | was-mowing → `Work:FINISHED` with `error_status=0` | full `msg` field |
| `docked` | `recharge_status` reaches 9 | battery + recharge_status |
| `low_battery` | `battery_power` crosses below `LOW_BATTERY_THRESHOLD` (one-shot per dip) | "Battery dropped below 20%" |
| `error` | unmapped non-zero `error_status` | firmware `error_msg` verbatim |
| `error_cleared` | non-zero `error_status` → 0 | "Previous error_status=X now 0" |
| `stuck` | dock-fail / collision codes (117, 124, 126, 153) | curated stock-app text |
| `safety` | PIN-protected hardstops (152, 154–160) — lift, tilt, motor stall, turn-over | curated stock-app text |
| `pin_locked` | code 151 | "Please enter the PIN code on the device." |
| `connection_lost` | LoRa data loss (codes 131, 132) | curated stock-app text |
| `gps_weak` | poor location quality (101, 105, 106, 202) | curated stock-app text |
| `map_error` | charging signal / boundary / mapping issues (112–114, 122, 123, 125) | curated stock-app text |
| `initialization_error` | code 133 | "Mower not yet initialized. Wait one minute and retry." |
| `hardware_fault` | TOF / camera / chassis (134, 136, 137, 170, 221, 444) | curated stock-app text |
| `blade_maintenance` | mowing hours since the last blade change reach the interval set in the app (History → Blades); once per change | hours since + interval |

The body for mapped error codes uses the **same English text the official Novabot v2.4.0 app shows** — extracted from the stock app's `mower_error_text.dart`. Unmapped codes fall through to the generic `error` event with the firmware's own `error_msg` as body, so nothing is lost.

## Channel 1 — ntfy.sh (free, no account)

The fastest path to phone notifications. ntfy is an open-source push service: install one app, subscribe to a topic, you're done. Public topics are unauthenticated, so pick a long random topic name (anyone subscribed to your topic can read your events).

### Setup

1. Pick a topic. Suggestion format: `novabot-<your-name>-<random>`. Example: `novabot-ramon-x7k9q`.

2. Add to `docker-compose.yml`:

    ```yaml
    services:
      opennova:
        environment:
          NTFY_TOPIC: "novabot-ramon-x7k9q"
          NTFY_URL: "https://ntfy.sh"      # default; change for self-hosted
          NTFY_PRIORITY: "4"               # 1=min .. 5=max, optional
    ```

3. Restart the container:

    ```bash
    docker compose up -d
    ```

4. Install the **ntfy** app (free, no account):
    - iOS: <https://apps.apple.com/us/app/ntfy/id1625396347>
    - Android: <https://play.google.com/store/apps/details?id=io.heckel.ntfy>

5. In the app, tap **+ Subscribe to topic**, enter your topic name (`novabot-ramon-x7k9q`), and confirm.

That's it. Trigger an event on your mower (start mowing, return to dock, etc.) and the push appears within seconds.

### Tags + filtering

Each push includes a tag pair `mower,<event_type>`. In the ntfy app you can long-press a topic → **Filter notifications** to show only specific event types. Useful if you only want to hear about errors and safety stops, not every start/finish.

### Self-hosting ntfy

If you'd rather not use the public `ntfy.sh` server, deploy your own:

```yaml
services:
  ntfy:
    image: binwiederhier/ntfy:latest
    command: ['serve']
    ports: ["8080:80"]
```

Then set `NTFY_URL: "http://your-ntfy-host:8080"` in OpenNova's environment. Topic still goes in `NTFY_TOPIC`.

## Channel 2 — Home Assistant (3 paths)

OpenNova exposes events to Home Assistant in three ways. Pick whichever your automations prefer:

### 2a — MQTT auto-discovery (easiest)

When `HA_MQTT_HOST` is set, OpenNova publishes:

- One sensor entity per cached field per mower (battery, GPS, error, msg, etc.)
- A live mower-map `image` entity (auto-fetches the rendered PNG)
- Per-event MQTT topics: `novabot/events/<SN>` (any event) and `novabot/events/<SN>/<event_type>` (filtered)

```yaml
environment:
  HA_MQTT_HOST: "192.168.0.200"
  HA_MQTT_PORT: 1883
  HA_MQTT_USER: "mqtt"
  HA_MQTT_PASS: "mqtt"
  RENDER_BASE_URL: "http://192.168.1.50"    # http://TARGET_IP, required for the map image
```

Use as automation trigger:

```yaml
trigger:
  - platform: mqtt
    topic: novabot/events/LFIN1231000211/stuck
action:
  - service: notify.mobile_app_mypho​ne
    data:
      title: 'Mower stuck'
      message: '{{ trigger.payload_json.message }}'
```

### 2b — Webhook trigger

```yaml
environment:
  HA_WEBHOOK_URL: "http://homeassistant.local:8123/api/webhook/novabot_events"
```

OpenNova POSTs the full event JSON to that URL on every event. HA-side automation:

```yaml
trigger:
  - platform: webhook
    webhook_id: novabot_events
action:
  - service: notify.notify
    data:
      message: "{{ trigger.json.title }}: {{ trigger.json.message }}"
```

### 2c — HTTP polling

If you don't want push at all:

```text
GET http://your-opennova/api/events/LFIN1231000211?limit=50
```

Returns a 200-event ring buffer per SN, newest first. Use HA's `rest` sensor if you want to display recent events in a Lovelace tile.

## Channel 3 — OpenNova mobile app (Expo Push)

Native iOS/Android push via Expo's free relay. **Auto-enabled** when you install the OpenNova app and grant notification permission — no env vars needed.

The app registers its push token with the server via `POST /api/push/register` on launch. Server stores per `(token, sn)` and fans out via `https://exp.host/--/api/v2/push/send` on every event. Stale tokens are GC'd automatically (Expo returns `DeviceNotRegistered` on next push, server deletes the row).

Expo Push limit: 600 notifications/sec/project worldwide. With realistic mower-event rates (~5/day/mower) you'd need 10M concurrent users to saturate. Non-issue at any sensible scale.

## Channel 4 — Stock Novabot app's Messages tab

Even without push, every detected event also lands as a row in the `robot_messages` table. The official Novabot v2.4.0 app polls this table on launch and surfaces it under **Settings → Messages**. The body text matches what the Novabot cloud would have shown for that error code, so users see familiar wording.

This isn't a push (no banner on lock screen, no sound) but it fills the in-app inbox so users get a complete history. Always on — no env vars.

## Combining channels

Channels are independent. If you set `NTFY_TOPIC` AND `HA_MQTT_HOST` AND `HA_WEBHOOK_URL`, every event fires through all three plus the `robot_messages` write plus Expo Push (if there are registered tokens). Choose what matches your setup; nothing is mutually exclusive.

## Reference: full env var list

| Variable | Default | Purpose |
|---|---|---|
| `NTFY_TOPIC` | — | Required to enable ntfy. Pick something long and random. |
| `NTFY_URL` | `https://ntfy.sh` | Public ntfy server or your self-hosted instance |
| `NTFY_PRIORITY` | (unset) | 1..5, optional, sets ntfy's `Priority` header |
| `HA_WEBHOOK_URL` | — | Set to enable the HA webhook channel |
| `HA_MQTT_HOST` | — | Required to enable the HA MQTT bridge + auto-discovery |
| `HA_MQTT_PORT` | `1883` | HA Mosquitto port |
| `HA_MQTT_USER` | (unset) | HA Mosquitto username (if your broker requires auth) |
| `HA_MQTT_PASS` | (unset) | HA Mosquitto password |
| `HA_DISCOVERY_PREFIX` | `homeassistant` | HA discovery topic prefix; rarely changed |
| `HA_THROTTLE_MS` | `2000` | Min ms between sensor publishes per mower |
| `HA_MAP_THROTTLE_MS` | `15000` | Min ms between map-image URL republishes (forces HA refresh) |
| `RENDER_BASE_URL` | — | Public URL of your OpenNova server (e.g. `http://192.168.1.50`); required for the HA image entity |
| `EVENTS_MQTT_TOPIC_PREFIX` | `novabot/events` | Prefix for local MQTT event publishes |
| `LOW_BATTERY_THRESHOLD` | `20` | Battery % crossing point for `low_battery` events |
