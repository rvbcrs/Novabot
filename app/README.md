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

## iOS — Bouwen op een fysiek apparaat via Xcode

### Vereisten
- Apple Developer account (gratis of betaald)
- iPhone verbonden via USB of op hetzelfde WiFi netwerk
- Xcode 16+ met je Apple ID ingelogd (Xcode → Settings → Accounts)

### Stappen

1. **Open het project in Xcode:**
   ```bash
   open ios/OpenNova.xcworkspace
   ```
   Gebruik ALTIJD `.xcworkspace` (niet `.xcodeproj`).

2. **Selecteer je team:**
   - Klik op het project "OpenNova" in de linkerbalk
   - Tab "Signing & Capabilities"
   - Selecteer je Apple Developer team bij "Team"
   - Xcode genereert automatisch een provisioning profile

3. **Selecteer je iPhone:**
   - Bovenaan in Xcode: kies je aangesloten iPhone als target device
   - De eerste keer moet je op je iPhone vertrouwen: Instellingen → Algemeen → VPN en apparaatbeheer → vertrouw je developer certificaat

4. **Bouw en installeer:**
   - Druk op de Play knop (▶) of `Cmd+R`
   - Xcode bouwt de app en installeert direct op je iPhone
   - Metro bundler start automatisch (of handmatig: `npx react-native start`)

5. **Wijzigingen testen zonder rebuild:**
   - JavaScript wijzigingen: shake je iPhone → "Reload" (of `Cmd+R` in simulator)
   - Native module wijzigingen (nieuwe Expo packages): Xcode rebuild nodig

### Veelvoorkomende problemen

- **"Untrusted Developer"**: Ga op je iPhone naar Instellingen → Algemeen → VPN en apparaatbeheer → vertrouw het certificaat
- **Signing error**: Controleer dat je Team is geselecteerd en Bundle Identifier uniek is
- **Pod errors**: `cd ios && pod deintegrate && pod install`

## iOS — TestFlight distributie

TestFlight is nodig om de app te delen met testers zonder dat ze een Mac nodig hebben.

### Vereisten
- **Betaald** Apple Developer account ($99/jaar)
- App aangemaakt in App Store Connect (appstoreconnect.apple.com)

### Via Xcode (aanbevolen)

1. In Xcode: Product → Archive
2. Wacht tot de archive klaar is → Organizer opent automatisch
3. Selecteer de archive → "Distribute App"
4. Kies "App Store Connect" → "Upload"
5. Doorloop de wizard (standaard opties zijn goed)
6. Na upload: ga naar appstoreconnect.apple.com → je app → TestFlight
7. Wacht op Apple's processing (~15-30 min)
8. Voeg testers toe via email → zij krijgen een TestFlight uitnodiging

### Via command line

```bash
cd ios

# 1. Archive bouwen
xcodebuild -workspace OpenNova.xcworkspace -scheme OpenNova \
  -sdk iphoneos \
  -configuration Release \
  -archivePath build/OpenNova.xcarchive \
  archive

# 2. IPA exporteren
xcodebuild -exportArchive \
  -archivePath build/OpenNova.xcarchive \
  -exportPath build/ipa \
  -exportOptionsPlist ExportOptions.plist

# 3. Uploaden naar App Store Connect
xcrun altool --upload-app -f build/ipa/OpenNova.ipa \
  -t ios -u your@email.com -p @keychain:AC_PASSWORD
```

**App-specific password aanmaken:**
1. Ga naar appleid.apple.com → Sign-In and Security → App-Specific Passwords
2. Genereer een wachtwoord
3. Sla op in Keychain: `xcrun altool --store-password-in-keychain-item AC_PASSWORD -u your@email.com -p <wachtwoord>`

## Android — Bouwen en installeren

### Vereisten
- Android Studio (voor SDK en build tools)
- Java 17 (`brew install openjdk@17`)
- Android telefoon met USB debugging aan (Instellingen → Over telefoon → 7x tikken op Build-nummer → Developer options → USB debugging)

### Development build (direct op telefoon)

```bash
# 1. Controleer dat je telefoon verbonden is:
adb devices

# 2. Bouw en installeer:
npx expo run:android

# Of via Gradle:
cd android
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

### Release APK bouwen (voor distributie)

```bash
cd android

# 1. Release APK bouwen
./gradlew assembleRelease

# APK staat in: app/build/outputs/apk/release/app-release.apk
```

### Release AAB bouwen (voor Google Play)

```bash
cd android

# 1. Release bundle bouwen
./gradlew bundleRelease

# AAB staat in: app/build/outputs/bundle/release/app-release.aab
```

### Signing configuratie

Voor release builds is een signing key nodig:

```bash
# 1. Genereer een keystore (eenmalig):
keytool -genkeypair -v -storetype PKCS12 \
  -keystore android/app/release.keystore \
  -alias opennova -keyalg RSA -keysize 2048 -validity 10000

# 2. Configureer in android/gradle.properties:
MYAPP_UPLOAD_STORE_FILE=release.keystore
MYAPP_UPLOAD_KEY_ALIAS=opennova
MYAPP_UPLOAD_STORE_PASSWORD=<je wachtwoord>
MYAPP_UPLOAD_KEY_PASSWORD=<je wachtwoord>
```

### APK direct delen

De debug of release APK kun je direct delen met testers:
- Via email, Google Drive, of een download link
- Testers installeren via "Onbekende bronnen toestaan" in Android instellingen
- Geen Google Play account nodig

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
