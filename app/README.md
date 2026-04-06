# OpenNova App

React Native (Expo bare workflow) app voor de Novabot maaier.

## Vereisten

- Node.js 20+
- Xcode 16+ (voor iOS)
- CocoaPods (`gem install cocoapods`)
- EAS CLI (`npm install -g eas-cli`)
- Apple Developer account (voor TestFlight)

## Installatie

```bash
cd app
npm install
cd ios && pod install && cd ..
```

## Development — iOS Simulator (lokaal, geen Expo cloud)

```bash
# 1. Start Metro bundler
npx react-native start --reset-cache

# 2. Bouw en installeer in simulator (apart terminal):
cd ios
xcodebuild -workspace OpenNova.xcworkspace -scheme OpenNova \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath build

# 3. Installeer in simulator:
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/OpenNova.app
xcrun simctl launch booted com.ramonvanbruggen.OpenNova
```

Of open het project in Xcode en druk op Run (Cmd+R):
```bash
open ios/OpenNova.xcworkspace
```

Gebruik ALTIJD `.xcworkspace` (niet `.xcodeproj`) — CocoaPods vereist dit.

## TestFlight — Lokaal bouwen + uploaden

```bash
# 1. Archive bouwen:
cd ios
xcodebuild -workspace OpenNova.xcworkspace -scheme OpenNova \
  -sdk iphoneos \
  -configuration Release \
  -archivePath build/OpenNova.xcarchive \
  archive

# 2. IPA exporteren:
xcodebuild -exportArchive \
  -archivePath build/OpenNova.xcarchive \
  -exportPath build/ipa \
  -exportOptionsPlist ExportOptions.plist

# 3. Uploaden naar TestFlight:
xcrun altool --upload-app -f build/ipa/OpenNova.ipa \
  -t ios -u user@example.com -p @keychain:AC_PASSWORD
```

Of via Xcode: Product → Archive → Distribute App → App Store Connect.

## Beschikbare simulators

```bash
xcrun simctl list devices available | grep iPhone
```

## Versie ophogen

De versie wordt beheerd via EAS (`appVersionSource: "remote"` in eas.json).
Bij elke `eas build` met `autoIncrement: true` wordt het buildnummer automatisch opgehoogd.

Voor handmatige versie wijziging: `app.json` → `expo.version`.

## Projectstructuur

```
app/
  src/
    components/    UI componenten
    context/       React context (auth, mqtt, demo mode)
    hooks/         Custom hooks
    navigation/    React Navigation setup
    screens/       Schermen (Home, Map, Schedule, Settings)
    services/      MQTT, BLE, API clients
    theme/         Kleuren, fonts
    types/         TypeScript types
  ios/             Native iOS project (Xcode)
  android/         Native Android project
  App.tsx          Entry point
```

## Troubleshooting

**Pod install faalt:**
```bash
cd ios && pod deintegrate && pod install
```

**Metro bundler cache:**
```bash
npx expo start --clear
```

**Xcode build errors na npm install:**
```bash
cd ios && pod install && cd ..
```

**Simulator niet gevonden:**
```bash
xcrun simctl list devices available
```
