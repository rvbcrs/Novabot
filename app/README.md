# OpenNova App

React Native (Expo bare workflow) app for the Novabot mower.

## Requirements

- Node.js 20+
- Xcode 16+ (for iOS)
- CocoaPods (`gem install cocoapods`)
- EAS CLI (`npm install -g eas-cli`)
- Apple Developer account (for TestFlight)

## Installation

```bash
cd app
npm install
cd ios && pod install && cd ..
```

## Development — iOS Simulator (local, no Expo cloud)

```bash
# 1. Start Metro bundler
npx react-native start --reset-cache

# 2. Build and install in simulator (separate terminal):
cd ios
xcodebuild -workspace OpenNova.xcworkspace -scheme OpenNova \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath build

# 3. Install in simulator:
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/OpenNova.app
xcrun simctl launch booted com.ramonvanbruggen.OpenNova
```

Or open the project in Xcode and hit Run (Cmd+R):
```bash
open ios/OpenNova.xcworkspace
```

ALWAYS use `.xcworkspace` (not `.xcodeproj`) — CocoaPods requires it.

## iOS — Building on a physical device via Xcode

### Requirements
- Apple Developer account (free or paid)
- iPhone connected via USB or on the same WiFi network
- Xcode 16+ signed in with your Apple ID (Xcode → Settings → Accounts)

### Steps

1. **Open the project in Xcode:**
   ```bash
   open ios/OpenNova.xcworkspace
   ```
   ALWAYS use `.xcworkspace` (not `.xcodeproj`).

2. **Select your team:**
   - Click the "OpenNova" project in the left sidebar
   - "Signing & Capabilities" tab
   - Select your Apple Developer team under "Team"
   - Xcode automatically generates a provisioning profile

3. **Select your iPhone:**
   - At the top of Xcode: pick your connected iPhone as the target device
   - The first time, you must trust the developer certificate on your iPhone: Settings → General → VPN & Device Management → trust your developer certificate

4. **Build and install:**
   - Press the Play button (▶) or `Cmd+R`
   - Xcode builds the app and installs it directly on your iPhone
   - Metro bundler starts automatically (or manually: `npx react-native start`)

5. **Testing changes without rebuild:**
   - JavaScript changes: shake your iPhone → "Reload" (or `Cmd+R` in simulator)
   - Native module changes (new Expo packages): Xcode rebuild required

### Common problems

- **"Untrusted Developer"**: On your iPhone go to Settings → General → VPN & Device Management → trust the certificate
- **Signing error**: Check that your Team is selected and Bundle Identifier is unique
- **Pod errors**: `cd ios && pod deintegrate && pod install`

## iOS — TestFlight distribution

TestFlight is required to share the app with testers who don't have a Mac.

### Requirements
- **Paid** Apple Developer account ($99/year)
- App created in App Store Connect (appstoreconnect.apple.com)

### Via Xcode (recommended)

1. In Xcode: Product → Archive
2. Wait for the archive to finish → Organizer opens automatically
3. Select the archive → "Distribute App"
4. Choose "App Store Connect" → "Upload"
5. Walk through the wizard (defaults are fine)
6. After upload: go to appstoreconnect.apple.com → your app → TestFlight
7. Wait for Apple's processing (~15-30 min)
8. Add testers by email → they receive a TestFlight invitation

### Via command line

```bash
cd ios

# 1. Build archive
xcodebuild -workspace OpenNova.xcworkspace -scheme OpenNova \
  -sdk iphoneos \
  -configuration Release \
  -archivePath build/OpenNova.xcarchive \
  archive

# 2. Export IPA
xcodebuild -exportArchive \
  -archivePath build/OpenNova.xcarchive \
  -exportPath build/ipa \
  -exportOptionsPlist ExportOptions.plist

# 3. Upload to App Store Connect
xcrun altool --upload-app -f build/ipa/OpenNova.ipa \
  -t ios -u your@email.com -p @keychain:AC_PASSWORD
```

**Creating an app-specific password:**
1. Go to appleid.apple.com → Sign-In and Security → App-Specific Passwords
2. Generate a password
3. Store in Keychain: `xcrun altool --store-password-in-keychain-item AC_PASSWORD -u your@email.com -p <password>`

## Android — Building and installing

### Requirements
- Android Studio (for SDK and build tools)
- Java 17 (`brew install openjdk@17`)
- Android phone with USB debugging enabled (Settings → About phone → tap Build number 7x → Developer options → USB debugging)

### Development build (directly on phone)

```bash
# 1. Check that your phone is connected:
adb devices

# 2. Build and install:
npx expo run:android

# Or via Gradle:
cd android
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

### Build release APK (for distribution)

```bash
cd android

# 1. Build release APK
./gradlew assembleRelease

# APK is at: app/build/outputs/apk/release/app-release.apk
```

### Build release AAB (for Google Play)

```bash
cd android

# 1. Build release bundle
./gradlew bundleRelease

# AAB is at: app/build/outputs/bundle/release/app-release.aab
```

### Signing configuration

Release builds need a signing key:

```bash
# 1. Generate a keystore (one-time):
keytool -genkeypair -v -storetype PKCS12 \
  -keystore android/app/release.keystore \
  -alias opennova -keyalg RSA -keysize 2048 -validity 10000

# 2. Configure in android/gradle.properties:
MYAPP_UPLOAD_STORE_FILE=release.keystore
MYAPP_UPLOAD_KEY_ALIAS=opennova
MYAPP_UPLOAD_STORE_PASSWORD=<your password>
MYAPP_UPLOAD_KEY_PASSWORD=<your password>
```

### Sharing the APK directly

You can share the debug or release APK directly with testers:
- Via email, Google Drive, or a download link
- Testers install via "Allow unknown sources" in Android settings
- No Google Play account required

## Available simulators

```bash
xcrun simctl list devices available | grep iPhone
```

## Bumping the version

The version is managed via EAS (`appVersionSource: "remote"` in eas.json).
Every `eas build` with `autoIncrement: true` automatically bumps the build number.

For manual version changes: `app.json` → `expo.version`.

## Project structure

```
app/
  src/
    components/    UI components
    context/       React context (auth, mqtt, demo mode)
    hooks/         Custom hooks
    navigation/    React Navigation setup
    screens/       Screens (Home, Map, Schedule, Settings)
    services/      MQTT, BLE, API clients
    theme/         Colors, fonts
    types/         TypeScript types
  ios/             Native iOS project (Xcode)
  android/         Native Android project
  App.tsx          Entry point
```

## Troubleshooting

**Pod install fails:**
```bash
cd ios && pod deintegrate && pod install
```

**Metro bundler cache:**
```bash
npx expo start --clear
```

**Xcode build errors after npm install:**
```bash
cd ios && pod install && cd ..
```

**Simulator not found:**
```bash
xcrun simctl list devices available
```
