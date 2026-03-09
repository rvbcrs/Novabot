# Troubleshooting

## Error Codes

### "Novabot RTK upgrading, please do not turn off" / "Novabot RTK error"

This error appears during firmware updates, especially when the app reports update success but then shows **"machine chassis error"**.

**Solution:**

1. Click "OK" first
2. Enter the password to unlock the error
3. If **"Novabot RTK error"** appears after entering the password: pull the mower from the charging station and reboot

### "No pairable device was identified"

!!! warning "Self-check first"
    Perform a self-check, especially if firmware is lower than v4.7.3 and v0.2.5 (check via App → Profile → Settings → About).

**Steps:**

1. Turn on the switch on the bottom of the mower
2. Delete the charging station and reconnect both charger and mower to the app
3. Pull the mower out of the charging station, restart it, check the time displayed on the screen
4. Go to Settings → "About" or "Novabot serial number" to verify the QR code is visible
5. Don't keep the mower on continuously if not connected to the app (except for monthly charging)

**Additional checks:**

- Verify WiFi name and password don't contain spaces or special characters
- Confirm WiFi is **2.4 GHz** (not 5 GHz)

### "Get signal info failed, pls retry"

1. Ensure the charging station is connected to the GNSS antenna
2. Check if the connection between charging station and antenna top is loose — reconnect
3. Retry and upload the app log with the time of the issue

### "No map! Please create a map"

Reboot the app — the previously created map will display on screen. This is a synchronization issue with map uploading.

### "Search bluetooth timeout"

1. Check the time displayed on the mower screen (photograph if incorrect)
2. Reboot the charging pile
3. Pull the mower out, restart it, and reconnect to the app
4. Disable Bluetooth on your phone, wait 2 seconds, re-enable
5. Enable location permission on your phone
6. Reboot the app
7. If still failing: repeat all steps (Bluetooth has a time limitation and re-enables when the charging pile is repowered)

!!! tip
    Upload the app log and provide the date of the issue if the error persists after multiple attempts.

### "NOVABOT's Bluetooth is disconnected. Please retry or exit mapping..."

If this error appears when you're almost finished creating a map:

1. Close the app
2. Disable Bluetooth on your phone, wait 2 seconds, re-enable
3. Open the app and create the map again
4. If Bluetooth remains disconnected: repower the mower (**remove it from the charging pile first!**)

### "Bluetooth Signal error" (v4.7.3+0.2.5+2.1.0)

When this error appears while creating lawn boundaries:

1. Repower the mower
2. Put your phone close to the mower

### GPS and Bluetooth Signals Are Weak

1. Check version of charging pile and mower (App → Profile → Settings → About)
2. Check the GNSS antenna's location (photo needed for verification)
3. **Do not operate the mower under a roof or shelter** — move forward slightly to avoid shelter and refresh
4. Reconnect charging station and mower to the app after deleting them
5. Ensure no obstacles between charging pile and mower
6. If still failing: keep the mower on and report the timestamp (for log analysis)

### Weak GPS and Difficult to Map

1. Check GNSS antenna placement — not under shelter, not behind glass, not near water
2. Move to an open area
3. Delete devices from the app and re-add

### "Start navigation failed, please check it"

Repower the mower if this error appears.

### "The charging station network is abnormal, please check it"

1. Repower the mower and wait a minute (may be caused by poor network)
2. Reboot the app (optional)

### "Set config info failed, please retry"

1. Read the provided instructions and download the designated app
2. Re-connect the charging pile and mower

### "Map upload failed"

**Diagnostic steps (in order):**

1. Verify charging pile and mower have been updated successfully (Profile → Settings → About)
2. If not updated: reinstall App 1.2.29, reconnect, and **press the red dot on Device Upgrade button until it disappears**
3. Continue updating to the newest version
4. Check phone has WiFi or mobile data access — move closer to WiFi if needed
5. WiFi name and password **cannot contain spaces or special characters**
6. Repower and reconnect

**If still failing with good WiFi and GNSS:**

1. Place the charging pile closer to the router
2. Remove metal objects around the GNSS antenna
3. Repower and retry

**Last resort:**

1. Upload app log (Profile → Settings → App Log Upload)
2. Keep mower powered on
3. Report the time of the issue to support

### "Data transmission error"

This indicates a temporary LoRa communication interruption between mower and base station:

- Usually restores automatically
- Can be manually recovered via the confirmation button
- Contact support if unresolved within 10 minutes

## WiFi Issues

### WiFi Stops Working

1. **Check for special characters**: Reset WiFi name and password if they contain spaces or special characters, then re-add charging pile and mower
2. **Test WiFi quality**: Use WiFi Analyzer (Android) or Airport Utility (iPhone) to verify signal strength
3. **Use phone hotspot** (recommended): Enable personal hotspot, reconnect using hotspot credentials (no spaces or special characters)
4. **Report**: Upload app log and contact support with the time of the issue
5. After reconnecting, Novabot may appear as **offline briefly** — this is normal during system initialization

## Mowing Issues

### Motor Error / Left Motor Error

1. Check for obstacles in the mowing deck
2. Check wheel resistance
3. Adjust grass density settings
4. Power cycle the mower
5. Clean the mower while it's in the charging dock

### Overheating

1. Remove the mower from the dock to cool down
2. Avoid direct sunlight during charging
3. Operate during cooler periods
4. Latest firmware automatically shuts down the camera at excessive temperatures

### Mower Difficult to Return to Charging Station

=== "Daytime"
    Use a dry cloth to clean the QR code on the charging station and retry.

=== "Nighttime"
    Remove strong light sources and stick black paper in the yellow-marked area to reduce reflections.

### Mower Appears Dead After Removing from Dock

**Step 1 — Basic checks:**

- Check switch position (bottom of mower)
- Check charging indicator status
- Remove any foam
- Check magnet placement

**Step 2 — Advanced diagnostics:**

- Inspect connectors
- Measure voltage with a multimeter

## Reporting Problems to Support

When contacting support@lfibot.com, include:

1. **Time** of the incident
2. **Screenshots** of error messages
3. **Serial numbers** of devices
4. **Registration email** address
5. **Videos** of the problem
6. **App logs** (Profile → Settings → App Log Upload)

!!! tip
    Leave the mower powered on for **6 hours** after an issue so support can retrieve mower logs from the backend.
