# Firmware & App Versions

!!! warning "Important"
    **Always use the matched APP version after a firmware update!**

## Version Compatibility Table

| APP Version | Platform | Mower Firmware | Station Firmware | Remarks |
|-------------|----------|----------------|------------------|---------|
| 1.2.29 | iOS (TestFlight) | v4.6.6 | v0.1.9 | Manually pushed by factory |
| 1.2.29 | Android (APK) | v4.6.6 | v0.1.9 | Manually pushed by factory |
| 2.0.1 | iOS (TestFlight) | v4.7.6 | v0.2.4 | Fix for special issue |
| 1.3.0 | Android (APK) | v4.7.6 | v0.2.4 | Fix for special issue |
| 2.2.0 | App Store / Google Play | v4.7.3 | v0.2.5 | Standard release |
| 2.2.0 | App Store / Google Play | v5.0.6 | v0.3.3 | Standard release |
| 2.3.8 | App Store / Google Play | v5.1.8 | v0.3.4 | Current release |

**Notes:**

- App 2.2.0 and later are compatible with firmware updates
- Special characters can now be used in WiFi credentials when connecting the mower
- Firmware update is available when the red dot appears on the OTA button
- If you don't know which firmware version your Novabot has, contact support@lfibot.com

## Changelog: v5.7.1 / v0.3.6 / App 2.3.8

### App Improvements

1. App 2.2.0+ compatible with firmware updates
2. Special characters in WiFi now supported
3. OTA update via red dot on OTA button
4. Download via App Store / Google Play
5. **Modify map** feature: left-click to enlarge areas, right-click to delete areas
6. **Path direction selection**: choose mowing angle and preview
7. Enhanced obstacle avoidance levels (based on v5.4.2, being improved)
8. Updated vision mode
9. Improved high/medium level obstacle detection and high grass recognition
10. **Manual controller**: adjustable max speed, no need to carry mower back to base

### Mowing & Mapping Improvements

1. Map displays inflated boundaries with black boxes indicating paths
2. Improved obstacle avoidance (ongoing)
3. Edge-cutting after completing mapped area
4. Second mowing capability
5. **Super large map upload (up to 1.5 acres / ~6000 m²)**

### Technical Fixes

| # | Fix |
|---|-----|
| 6 | Internal coverage module errors |
| 7 | Self-crossing issues during mapping |
| 8 | Positioning problems |
| 9 | LoRa communication optimization |
| 10 | Collision avoidance improvements |
| 11 | Motor protection enhancements |
| 12 | Charging station return improvements |
| 13 | Path error corrections |
| 14 | Improved: returning to charging station, out-of-boundary recovery, OTA update speed |

### Schedule Improvements

1. Unlimited schedule creation
2. Current date display
3. Time directly adjustable (no reset to 8:00)

## Changelog: v5.6.x / v0.3.6 (Test Version)

### Obstacle Sensitivity — 3 Levels

| Level | Sensors | Description |
|-------|---------|-------------|
| **Low** | Collision only | ToF and Camera are NOT used. Humans, animals, and unmapped obstacles cause collisions for detection. |
| **Medium** | ToF + Camera | Detection mode |
| **High** | ToF + Camera | Segmentation mode |

### Hardware Configuration

- **Two left ToF cameras**: Distance and obstacle height detection
- **Right camera**: Captures obstacle images across different modes to identify objects

### 18 Specific Improvements

1. Positioning recovery enhancement
2. Coverage module error fixes
3. Self-crossing during mapping fixes
4. Segmentation forcing improvements
5. LoRa frequency reduction
6. **CPU temperature threshold increased to 96°C**
7. Vision model updates
8. Obstacle sensitivity refinement
9. Charging station navigation improvements
10. Map editing fixes
11. Out-of-bounds recovery logic
12. RTK stability improvements
13. Edge-stuck resolution
14. Environmental adaptation enhancements
15-18. Additional error reduction and optimization

### Testing Requirements

Users evaluating this version must test:

- Effectiveness during poor location conditions
- All three obstacle sensitivity levels
- Document failures with images/videos including timestamps and temperatures
- Report issues related to positioning, LoRa, overheating, or boundary violations
