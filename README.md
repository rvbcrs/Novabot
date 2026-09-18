# OpenNova — Self-hosted Novabot Cloud Replacement

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/rvbcrs) [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-%E2%98%95-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/rvbcrs) [![PayPal](https://img.shields.io/badge/PayPal-donate-00457C?logo=paypal&logoColor=white)](https://paypal.me/rvbcrs)

Replace the Novabot cloud with your own local server. Your mower and charging station connect to **your server** on your own network: no cloud dependency, no outages, full control.

Novabot, the company, has gone out of business. OpenNova keeps your mower working.

## What is OpenNova?

A single Docker container that includes everything your Novabot needs:

- **MQTT broker** (port 1883): mower and charger connect here
- **Cloud API** (ports 80/443): compatible with the official Novabot app
- **Web dashboard and admin panel**: maps, schedules, diagnostics, firmware
- **DNS server** (optional): redirects `mqtt.lfibot.com` to your server
- **mDNS helper**: mowers on custom firmware find the server by name

The official Novabot app keeps working; it talks to your server instead of the cloud. There is also an [OpenNova app](https://wiki.ramonvanbruggen.nl/user-guide/opennova-app/) that needs no DNS tricks at all.

## Installing

Everything you need is on one page: **[Installing OpenNova](https://wiki.ramonvanbruggen.nl/guide/docker/)** (the same text lives in this repository at [`docs/guide/docker.md`](docs/guide/docker.md)). It starts with the only question that matters, *where will it run*, and gives you one `docker-compose.yml` for it.

In short:

1. Linux is the place to run it: a NAS, a Raspberry Pi, a Proxmox VM. macOS works with one limitation; Windows is not recommended.
2. Copy the compose from that page, change `TARGET_IP`, run `docker compose up -d`.
3. Point `mqtt.lfibot.com` at your server: [DNS Setup](https://wiki.ramonvanbruggen.nl/guide/dns-setup/).
4. Log in with the app.

No Docker experience? The [Raspberry Pi Installer](https://wiki.ramonvanbruggen.nl/guide/raspberry-pi-installer/) writes a ready-made SD card.

## Supported devices

| Device | Status |
|--------|--------|
| Novabot N1000 mower | Fully supported |
| Novabot N2000 mower | Fully supported |
| Novabot charging station | Fully supported |

## Custom firmware (beta)

> Custom firmware is experimental. It can leave the mower unusable and can
> wipe your maps. OpenNova takes a fresh backup before every flash, but install
> it only if you accept the risk.

Custom builds (`v6.0.2-custom-*`) add SSH access, discovery of the server by name, remote ROS 2 access, and the map editing that the dashboard builds on. They are delivered over the air from the dashboard. See [Stock vs. Custom Firmware](https://wiki.ramonvanbruggen.nl/user-guide/stock-vs-custom-firmware/) and [Custom Firmware](https://wiki.ramonvanbruggen.nl/firmware/custom-firmware/).

## Documentation

The wiki: **[wiki.ramonvanbruggen.nl](https://wiki.ramonvanbruggen.nl)**. Its source is the [`docs/`](docs/) folder here.

## Community

[GitHub Issues](https://github.com/rvbcrs/Novabot/issues) for bug reports and feature requests. Please attach the output of **Why is it not coming online?** from the admin panel when something does not connect.

## License

This project is for personal, non-commercial use with Novabot devices you own.

---

**This is beta software. Use at your own risk. Your mower is an expensive device; test carefully.**
