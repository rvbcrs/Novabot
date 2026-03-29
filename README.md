# OpenNova — Self-hosted Novabot Cloud Replacement

Replace the Novabot cloud with your own server. Control your mower and charging station locally — no cloud dependency, no subscriptions.

## Quick Start

### 1. Start the server

```bash
docker compose up -d
```

Dashboard: http://localhost:3000 · MQTT: port 1883

### 2. Provision your devices

Download the **OpenNova app** for your phone:
- **iOS**: [TestFlight](https://testflight.apple.com/join/YOUR_LINK)
- **Android**: Download APK from [Releases](https://github.com/rvbcrs/Novabot/releases)

Or use the **desktop tool** (Mac/Windows/Linux):
- Download from [Releases](https://github.com/rvbcrs/Novabot/releases)
- Run it, open http://localhost:7789

### 3. That's it!

The app provisions your charger and mower via Bluetooth directly to your server's IP address. No DNS rewrites, no custom firmware, no complex setup.

## How it works

1. **BLE Provisioning**: The app connects to your Novabot devices via Bluetooth and configures them with your WiFi credentials + your server's IP address.
2. **MQTT**: Devices connect to your server's MQTT broker on port 1883.
3. **Dashboard**: Monitor and control your devices via the web dashboard.

## Requirements

- Docker (any platform: Mac, Windows, Linux, NAS, Raspberry Pi)
- A phone with Bluetooth (iOS or Android) for initial provisioning
- Novabot mower and/or charging station on the same WiFi network

## Configuration

Create a `.env` file next to `docker-compose.yml`:

```env
# Required: generate with: openssl rand -hex 32
JWT_SECRET=your_random_secret_here

# Optional: enable web dashboard (work in progress)
# ENABLE_DASHBOARD=true

# Optional: your server IP (only needed for TLS/DNS features)
# TARGET_IP=192.168.0.177

# Optional: admin email (auto-promoted to admin on startup)
# ADMIN_EMAIL=your@email.com
```

## Admin Panel

Access the admin panel at `http://your-server:3000/admin`. The first registered user is automatically promoted to admin.

## Supported Devices

| Device | Status |
|--------|--------|
| Novabot N1000 Mower | ✅ Fully supported |
| Novabot N2000 Mower | ✅ Fully supported |
| Novabot Charging Station | ✅ Fully supported |
| BestMow (rebrand) | 🔄 In progress |

## Community

- [Facebook Group](https://facebook.com/groups/novabot) — Share your setup, get help
- [GitHub Issues](https://github.com/rvbcrs/Novabot/issues) — Bug reports

## License

This project is for personal, non-commercial use with Novabot devices you own.
