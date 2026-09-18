# User Guide

Welcome. This section is for **mower owners** — people who bought a Novabot, lost (or want to leave) the LFI cloud, and want their mower to keep working forever on their own network.

It does **not** assume you have Docker experience, know what a JWT is, or want to read decompiled firmware. The Wiki's other tabs (HTTP API, MQTT Protocol, BLE Protocol, Firmware) exist for developers and reverse-engineers; this tab is for everyone else.

## What is OpenNova?

A local replacement for the Novabot cloud servers. Once it runs on your network:

- Your **Novabot app keeps working** without LFI's servers being online.
- The mower talks to **your** server instead of `mqtt.lfibot.com`.
- Maps, schedules, work history, and OTA updates all stay inside your house.
- New community features (multi-user, dashboards, Home Assistant, push notifications) are added on top.

If LFI shuts down their cloud tomorrow, your mower keeps running. If their cloud is already gone for you, OpenNova brings it back.

## What hardware does it need?

A small always-on computer to run the server. Anything works as long as it has Docker:

| Option | Notes |
|--------|-------|
| Synology / QNAP / ZimaOS / TrueNAS | Easiest — install Docker, run one container |
| Raspberry Pi 4 or 5 | Cheap, low power, sits in a drawer |
| Old laptop or PC running Linux | Free if you already have one |
| Mac mini / Mac with Docker Desktop | Works, with one limitation: no discovery by name from inside Docker Desktop; the mower comes in through the DNS redirect. And the Mac has to stay awake. |
| Windows PC running Docker | Not recommended. Same limitation as the Mac plus port and firewall quirks; a Raspberry Pi is cheaper than the debugging. |

You do **not** need a powerful machine. The mower does the hard work — the server just stores data and routes messages.

## Quick navigation

| If you want to… | Read |
|-----------------|------|
| Install OpenNova (any Linux box, NAS, Mac) | [Installing OpenNova](../guide/docker.md) |
| Start from zero with a Raspberry Pi | [Raspberry Pi Installer](../guide/raspberry-pi-installer.md), or [by hand](../guide/beginner-installation.md) |
| Connect the app after installing | [First Run](../guide/getting-started.md) |
| Configure DNS so the app finds your server | [DNS Setup](../guide/dns-setup.md) |
| Find your way around the server's admin web UI | [Admin Panel](admin-panel.md) |
| Back up + restore your maps | [Map Backup & Restore](map-backup-restore.md) |
| Map an area by walking instead of driving | [RTK Walker mapping](rtk-walker-mapping.md) |
| Update walker firmware over the air | [Walker OTA](walker-ota.md) |
| Use the OpenNova app on your phone | [OpenNova App](opennova-app.md) |
| Pair a fresh mower or charger | [Mower Provisioning Flow](../flows/mower-provisioning.md) |
| Update mower firmware | [OTA Update Flow](../flows/ota-update.md) |
| Fix common problems | [Troubleshooting](troubleshooting.md) |
| Read the original LFI manuals + FAQ | [LFI Knowledge Base (archived)](../reference/NOVABOT-ZENDESK-WIKI.md) |
| Let someone help you remotely | Admin panel → **Remote Support** toggle (see [Admin Panel](admin-panel.md)) |
| Update the OpenNova app itself | [App Updates](../guide/app-updates.md) |

## LFI Knowledge Base archive

Before LFI shut down their cloud, all their official manuals, FAQ entries, and error-code explanations lived on `lfibot.zendesk.com`. That site can go offline at any time, so we extracted the full content via the Zendesk API on 2026-03-08 and kept a local copy:

**[LFI Knowledge Base (archived)](../reference/NOVABOT-ZENDESK-WIKI.md)** — installation, charger placement, mapping, schedules, OTA, every error code from the original manual. The content is in Dutch (translated from the original) and is what most non-technical questions are answered by.

## How help works

There is **no LFI support hotline** for OpenNova users. The community handles support:

- **Bug?** Open a [GitHub issue](https://github.com/rvbcrs/Novabot/issues/new/choose).
- **Question?** Use [GitHub Discussions](https://github.com/rvbcrs/Novabot/discussions).
- **Logs to share?** Use the **Remote Support** card in your admin page — that gives Ramon (the project maintainer) a one-session, you-approved shell into your container to diagnose. Every keystroke is logged on **your** disk for review.

Before filing an issue: skim [Troubleshooting](troubleshooting.md). Most "mower offline" or "no maps" reports are one of the same five things.

## Known limitations

- **Mac / Windows Docker Desktop has limited mDNS.** Auto-discovery (`opennova.local`) may not work because the container runs inside a Linux VM. You can still use the server — just configure DNS manually so the mower knows where to find it.
- **iOS app requires a real TLS certificate** for the Novabot stock app to connect (Apple blocks self-signed). The admin page has a Certificate Setup card that installs an OpenNova CA on the phone.
- **The Novabot stock app is third-party software.** OpenNova mimics the cloud API so closely that the stock app usually works unchanged, but new app versions occasionally break things. The [OpenNova app](../guide/app-updates.md) is our own community build that we control end-to-end.
