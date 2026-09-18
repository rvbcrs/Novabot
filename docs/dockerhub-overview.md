# OpenNova

Self-hosted replacement for the Novabot mower cloud. Your mower and charging
station connect to this container on your own network instead of to a cloud
that no longer exists.

One container: MQTT broker (1883), the cloud API the official app expects
(80/443), a web dashboard and admin panel, optional built-in DNS, and an mDNS
helper for mowers on custom firmware.

## Install

One page, one `docker-compose.yml`, one line to change:
**https://wiki.ramonvanbruggen.nl/guide/docker/**

Linux (NAS, Raspberry Pi, Proxmox) is where it belongs. macOS works with a
limitation, Windows is not recommended; the page explains why.

## Tags

| Tag | What it is |
|---|---|
| `latest` | Current release |
| `beta` | Next release, for testers |
| `2026.0916.2325` and similar | A specific release, pinned |

## Source and issues

https://github.com/rvbcrs/Novabot
