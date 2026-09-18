# Auto-discovery (zero-touch MQTT redirect)

OpenNova mowers running custom firmware can find your OpenNova server on
the LAN automatically — no DNS rewrite, no BLE re-pairing, no SSH. This
guide explains how it works and how to migrate the server between hosts
(laptop ↔ NAS ↔ Raspberry Pi) without touching the mower.

## How it works

1. The OpenNova server advertises itself on the local network as
   `opennova.local` (and the legacy `opennovabot.local`) via mDNS — the
   same service-discovery protocol AirPrint and Chromecast use.
2. The mower's `mqtt_node` polls those names every 60 seconds. When the
   resolved IP changes from the one in the running config and stays
   changed for two consecutive polls, the mower atomically rewrites
   `json_config.json`, switches its MQTT client to the new broker, and
   publishes a `server_migrated` event.
3. Boot-time `set_server_urls.sh` does the same lookup, so a mower that
   was offline during your migration picks up the new IP on next power
   cycle.

Net result: install OpenNova on a new host, leave the mower alone, and
within ~3 minutes it has followed you over.

## Migrating laptop → NAS

1. Install OpenNova on the NAS with the compose from
   [Installing OpenNova](docker.md). It includes `opennova-mdns`, the helper
   that does the advertising from the host network; the main container on
   docker's bridge cannot be heard on the LAN by itself.
2. Copy the `data/` directory off the laptop container to the NAS so the
   account, devices, and maps follow:
   ```bash
   rsync -av /Users/<you>/Novabot/data/ nas:/path/to/opennova/data/
   ```
3. Stop the laptop container. Don't change DNS settings — the mower will
   fall through to the new mDNS responder on the NAS.
4. Wait ~3 minutes. The mower's discovery loop notices the laptop is
   gone, sees the NAS responding to `opennova.local`, debounces, and
   reconnects.
5. Verify by tailing the NAS container log: a new `[MQTT] CONNECT DEV`
   line appears for your mower's SN, and the dashboard shows it as
   online.

If you'd rather not wait: power-cycle the mower. Boot-time discovery
catches the new IP immediately.

## Network requirements

mDNS uses UDP multicast on `224.0.0.251:5353`. It works out of the box on
flat home LANs (single subnet, single SSID, no VLAN bridge). It does
**not** work across:

- VLAN boundaries unless the bridge has IGMP snooping / mDNS reflector
  enabled (Unifi has this in network settings; eero / Google WiFi
  generally do not).
- Some "guest network" SSIDs that isolate clients.
- A container on docker's bridge, on its own. Multicast never reaches
  `docker0`, and a published `5353/udp` mapping does not change that (it
  only catches packets sent to the host's own address). That is what the
  `opennova-mdns` helper in the standard compose is for: it runs on the host
  network and advertises for the main container.

If mDNS is blocked on your network, fall back to the original DNS
rewrite path: point `mqtt.lfibot.com` at the OpenNova IP via Pi-hole,
AdGuard, or your router's DNS overrides.

## Verifying the advertiser is up

From any Linux/macOS host on the same LAN:

```bash
dns-sd -G v4 opennova.local      # macOS
avahi-resolve -n opennova.local  # Linux
```

You should see the OpenNova server's IP in under a second. From inside
the OpenNova container:

```bash
docker logs opennova | grep MDNS
# [MDNS] advertising opennova.local, opennovabot.local → 192.168.1.50 (ttl=120s)
```

## Verifying the mower picked up the new IP

The mower publishes a `server_migrated` event the first time it
reconnects to a new broker. You'll see it in three places:

- Dashboard event log under the affected SN.
- The MQTT topic `novabot/events/<SN>/server_migrated`.
- `GET /api/events/<SN>?limit=10` — the most recent event includes
  `event_type: server_migrated` with `from_ip` / `to_ip`.

If you set `NTFY_TOPIC` in your compose, the migration also pushes a
notification to your phone.

## Configuration knobs

Server (`docker-compose.yml` environment):

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENABLE_MDNS` | `true` | Set `false` to disable the advertiser entirely |
| `MDNS_HOSTNAMES` | `opennova.local,opennovabot.local` | Hostnames to advertise |
| `MDNS_TTL` | `120` | A-record TTL in seconds |

Mower (`/userdata/lfi/json_config.json`, `mqtt.discovery` section):

```json
{
  "mqtt": {
    "value": { "addr": "192.168.1.50", "port": 1883 },
    "discovery": {
      "enabled": true,
      "interval_s": 60,
      "debounce": 2,
      "hostnames": ["opennova.local", "opennovabot.local"]
    }
  }
}
```

`enabled=false` turns the runtime loop off; the boot-time discovery in
`set_server_urls.sh` is unaffected.

## Stock firmware

Stock firmware does not auto-discover. It always asks for
`mqtt.lfibot.com`. To redirect a stock mower to OpenNova, point that
hostname at the server via your network's DNS (Pi-hole, AdGuard,
router DNS rewrite, or the container's built-in `ENABLE_DNS=true`
dnsmasq).

## avahi already on the host (ZimaOS, CasaOS, Synology)

Most NAS systems run `avahi-daemon`, which also listens on `5353/udp`. That
is fine: mDNS responders are built to share that port (`SO_REUSEADDR` plus the
multicast group), and `opennova-mdns` does. Both answer; avahi for the NAS's
own name, `opennova-mdns` for `opennova.local`. Nothing to configure.

Check from a shell on the NAS:

```bash
docker logs opennova-mdns
# [MDNS-ONLY] advertising opennova.local -> 192.168.1.50 on 5353/udp (host network, detected)
```

And the proof that matters, on the mower or in the admin panel's
*Why is it not coming online?* under **Mower → mDNS**:

```bash
getent hosts opennova.local
# 192.168.1.50   opennova.local
```

## Switching a *running* mower to a new server without rebooting

Custom firmware before Phase 2 of this feature lands shipped with a
boot-time discovery script (`set_server_urls.sh`) that respects existing
custom MQTT configs — it logs `MQTT addr KEPT (custom)` and won't
overwrite a non-`mqtt.lfibot.com` host. Useful safety, but it means you
can't trigger the migration just by re-running that script.

The reliable soft-restart procedure (verified live on `LFIN1231000211`,
2026-04-29):

```bash
ssh root@<mower-ip>   # password: novabot

# 1. Rewrite both config files in place
python3 -c "
import json
p = '/userdata/lfi/json_config.json'
d = json.load(open(p))
d['mqtt']['value']['addr'] = '192.168.1.50'   # new server IP
open(p, 'w').write(json.dumps(d, indent=2))
"
printf '%s' '192.168.1.50:80' > /userdata/lfi/http_address.txt

# 2. Kill mqtt_node — mqtt_node_monitor.sh respawns it within ~3s,
#    re-reading the config we just wrote.
kill $(pgrep -f /root/novabot/install/novabot_api/lib/novabot_api/mqtt_node)
```

What happens:

1. `mqtt_node_monitor.sh` (already running as part of `novabot_launch`)
   notices the binary died.
2. It respawns mqtt_node. The new process reads the now-updated
   `json_config.json` and `http_address.txt`.
3. mqtt_node connects to the new broker. Verify with `ss -tnp | grep
   1883` on the mower, or `docker logs opennova | grep CONNECT` on the
   server.

Importantly, **a single `kill` is enough**. The monitor script handles
the respawn cleanly — no need to kill twice or restart
`novabot_launch`. Rebooting the mower is heavier and unnecessary.

The full Phase 2 implementation (the `discovery_loop` in mqtt_node)
removes the manual edit — once a custom firmware build with the loop is
flashed, the mower polls mDNS every 60 s and switches automatically
without any SSH at all.
