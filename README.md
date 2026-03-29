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

## Building from source

### Android APK

```bash
cd app
npm install
npx expo prebuild --platform android --clean
cd android
./gradlew assembleRelease
```

APK: `android/app/build/outputs/apk/release/app-release.apk`

### iOS (TestFlight)

```bash
cd app
npm install
npx expo prebuild --platform ios --clean
```

Then in Xcode:
1. Open `ios/OpenNova.xcworkspace`
2. Select **Any iOS Device (arm64)** as target
3. **Product → Archive**
4. **Distribute App → TestFlight Internal Only**

### Desktop Bootstrap Tool

```bash
cd bootstrap
npm install
npm run build
npx @yao-pkg/pkg dist/index.js --target node20-macos-arm64,node20-macos-x64,node20-windows-x64 --output dist/binaries/novabot-bootstrap
```

### Docker Server

```bash
docker compose build --no-cache
docker push rvbcrs/opennova:latest
```

## Project Structure

```
server/              # Express + MQTT broker (Node.js)
dashboard/           # Web dashboard (React + Vite)
app/                 # Mobile app (React Native + Expo)
bootstrap/           # Desktop provisioning tool (Node.js + React)
firmware/
  charger/           # ESP32 charger firmware research
  stm32/             # STM32 MCU firmware patches
  esp32-tool/        # ESP32 touchscreen provisioning tool
mower/               # Python robot_decision replacement
docs/                # Reference documentation
research/            # Firmware analysis, captures, decompiled code
```

## Community

- [Facebook Group](https://facebook.com/groups/novabot) — Share your setup, get help
- [GitHub Issues](https://github.com/rvbcrs/Novabot/issues) — Bug reports

## License

This project is for personal, non-commercial use with Novabot devices you own.
