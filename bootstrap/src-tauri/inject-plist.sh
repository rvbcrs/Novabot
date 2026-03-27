#!/bin/bash
# Inject Location Services + Bluetooth keys into the app bundle Info.plist
APP="src-tauri/target/release/bundle/macos/OpenNova.app"
PLIST="$APP/Contents/Info.plist"

if [ ! -f "$PLIST" ]; then
  echo "Info.plist not found at $PLIST"
  exit 1
fi

/usr/libexec/PlistBuddy -c "Add :NSLocationWhenInUseUsageDescription string 'OpenNova needs location access to scan for nearby WiFi networks.'" "$PLIST" 2>/dev/null
/usr/libexec/PlistBuddy -c "Add :NSLocationUsageDescription string 'OpenNova needs location access to scan for nearby WiFi networks.'" "$PLIST" 2>/dev/null
/usr/libexec/PlistBuddy -c "Add :NSBluetoothAlwaysUsageDescription string 'OpenNova uses Bluetooth to provision Novabot devices.'" "$PLIST" 2>/dev/null

echo "Injected Location + Bluetooth keys into $PLIST"
