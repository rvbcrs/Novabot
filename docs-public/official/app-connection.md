# Connecting Novabot to the App

## Step 1: Connect Charging Station

### 1.1 Initial Connection

1. Ensure your device's **Bluetooth is turned on**
2. Scan the **QR code on the charging pile** to connect

### 1.2 Configure WiFi

After successful Bluetooth connection, enter your WiFi credentials.

!!! warning "WiFi Requirements"
    - WiFi **must be 2.4 GHz** — 5 GHz is not supported
    - WiFi name and password must **not contain spaces or special characters**
    - If connection fails, verify you're using 2.4 GHz and retry

You may select alternate networks from the available list if needed.

### 1.3 Verify Location and Antenna

- Reconnect the charging station to the top of the GNSS antenna if an error message appears
- It may take **1-2 minutes** to complete GPS initialization

!!! info
    If you move the antenna or charging pile after this step, you will need to re-add the charging pile and input the WiFi again.

## Step 2: Connect Mower

1. Access the **mower settings menu** via the button on the mower screen
2. Navigate to the **About** section
3. Locate the device's **QR code and serial number**
4. Scan the QR code with the app

### Initial Status

Upon connection, your mower may temporarily display as **offline** during system initialization — this is normal behavior.

!!! note
    The app currently cannot display real-time signal strength metrics for WiFi, GPS antenna, mower, or Bluetooth. Diagnostic tools may be provided if problems occur.

## Checking WiFi Quality

Novabot uses **2.4 GHz WiFi** because it offers broader coverage over long distances and can penetrate obstacles better than 5 GHz.

### Signal Strength (RSSI)

**RSSI** (Received Signal Strength Indicator) measures signal power:

- Values higher than **-80 dBm** indicate good coverage
- **Android**: Install the "WiFi Analyzer" app to check
- **iPhone**: Use the "Airport Utility" app

### Testing WiFi

=== "Recommended Method"
    Enable **personal hotspot** on your phone, then reconnect the charging pile and mower using the hotspot WiFi name and password (no spaces or special characters).

=== "Alternative"
    Place the charging station closer to the router and retry.

## App & Mower Screen Indicators

| Symbol | Purpose | Details |
|--------|---------|---------|
| **GPS** | Location via RTK | GNSS antenna + mower receive satellite signals. Place antenna in open area. |
| **Bluetooth** | Phone control + mapping | Keep phone close to mower when BT is not working well. |
| **WiFi** | Communication via router | Remote control and data exchange. Move devices closer to router if needed. |
| **LoRa** | Mower ↔ station communication | Low-power distance detection. Works in weak network situations. **Cannot be manually adjusted by users.** |

### Status Colors

| Color | Meaning |
|-------|---------|
| **Cyan** | Good condition |
| **Red** | Bad condition |
| **Grey** | Offline |

## Charging Station LED Indicators

| LED State | Meaning |
|-----------|---------|
| **Off** | Mower not connected (even though power is on) |
| **Red solid** | Mower is charging |
| **Green solid** | Fully charged, mower still docked |
| **Red flashing** | Network error |
| **Red + green flashing** | No network connection |
| **Red + green solid** | Successful network connection |
