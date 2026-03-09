# Installation Guide

## Charging Station & GNSS Antenna Placement

Correct placement is **critical** for reliable GPS/RTK performance.

### Placement Rules

1. **120-degree clearance**: Keep 120 degrees from the top of the GNSS antenna free of obstacles
2. **Angle rule**: Tall obstacles must remain below a 30-degree angle from the antenna's horizontal line
3. **Vegetation clearance**: Maintain at least 20cm from bushes/low walls to the antenna top
4. **No metal objects**: Avoid metal objects nearby (fences, gates, etc.) — they interfere with GPS signals
5. **Flat terrain**: Install on a flat lawn — avoid slopes, potholes, and metal ground
6. **WiFi range**: Install close to your home WiFi signal (2.4 GHz recommended)
7. **2-meter clearance**: Keep at least 2 meters around the charging station free of obstacles and sprinklers
8. **Security radius**: Optional 3.5-meter radius for security functions
9. **Perpendicular to lawn edge**: Position the station perpendicular to the lawn border, facing the grass

!!! warning "Do not relocate after setup"
    After initial setup, **do not move the GNSS antenna or charging station**. Any relocation requires remapping. Moving more than 5 meters always requires a full remap.

!!! danger "Glass and reflective surfaces"
    Do not place the GNSS antenna close to glass — it affects signal receiving and causes RTK issues.

## Physical Installation

### 5 Assembly Steps

1. **Bracket assembly**
2. **Antenna/cord installation**
3. **Velcro securing**
4. **Vertical ground insertion** — angle with the ground cannot be greater than 10 degrees
5. **Wire/groove alignment**

### 7 Charging Station Guidelines

1. Placement on flat lawn
2. Proximity to WiFi router
3. 2-meter obstacle clearance around the station
4. Optional security radius (3.5m)
5. Perpendicular positioning to lawn edge
6. Wall-mounted power supply **at least 30cm from the ground**
7. Power connection

## Firmware Updates (OTA)

1. Dock the mower in the charging station and ensure it's connected
2. Navigate to **Profile → Setting → About**
3. Find **"NOVABOT Device Upgrade (OTA)"**
4. Press OK to start the update
5. **The full update takes 20-30 minutes**

!!! warning "During update"
    - Keep the mower on the charging station
    - Do **NOT** manually cut power
    - If the update gets stuck: remove the mower, reboot it, and retry

### Post-Update Behavior

After a firmware update, the app may report **"machine chassis error"** — this is normal:

1. Click "OK"
2. Enter the password to unlock the error
3. If **"Novabot RTK error"** appears after entering the password: pull the mower from the charging station and reboot

## Disconnecting from the App

1. Open the Novabot app → select **My devices** (top right of homepage)
2. Press **"About Novabot"** and delete

!!! important "Order matters"
    The **mower must be removed before the charger**. Delete the mower first, then the charging station.

3. Go to **My devices** → find **"About charger"** and delete
