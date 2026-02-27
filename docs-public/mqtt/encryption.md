# MQTT Encryption

## Overview

| Device | Firmware | Encryption | Direction |
|--------|----------|-----------|-----------|
| Charger | v0.3.6 | **None** (plain JSON) | Both directions |
| Charger | **v0.4.0** | **AES-128-CBC** | Both directions |
| Mower | All versions | **AES-128-CBC** | Both directions |

The charger firmware v0.3.6 sends and receives plain JSON.
Charger firmware **v0.4.0 adds AES-128-CBC encryption** — identical key scheme as the mower.
The mower encrypts all MQTT messages with AES-128-CBC.

---

## Mower AES-128-CBC Encryption

Discovered via Blutter decompilation of APK v2.4.0 (`encrypt_utils.dart`).


!!! lock "Private section"
    This section contains sensitive security details (encryption keys, credentials,
    vulnerability specifics) and is only available in the private wiki.


### Encrypted Message Sizes

| Report Type | Encrypted | Blocks | Plaintext | Content |
|-------------|-----------|--------|-----------|---------|
| `report_state_robot` | 800B | 50 | ~750B | Status, battery, GPS, errors |
| `report_exception_state` | 144B | 9 | ~100B | Sensors, emergency stop, WiFi |
| `report_state_timer_data` | 480-496B | 30-31 | ~440B | GPS, timer tasks |

MQTT overhead per message: 37 bytes.

### Proof of AES-CBC Mode

1. All payloads are **exactly divisible by 16** (AES block size)
2. Shannon entropy **7.5-7.8 bits/byte** — uniform byte distribution
3. **Block boundary divergence**: two type-2 payloads (480B vs 496B) identical until byte 208, then 100% divergent — this is the CBC cascade effect
4. Confirmed by successful decryption

---

## Password Encryption (Separate System)

The app uses a **different** AES setup for encrypting login passwords.


!!! lock "Private section"
    This section contains sensitive security details (encryption keys, credentials,
    vulnerability specifics) and is only available in the private wiki.


---

## App Version Differences

| Feature | v2.3.8 | v2.4.0 |
|---------|--------|--------|
| `encrypt_utils.dart` | **Missing** | Present |
| Mower MQTT decryption | None → `jsonDecode()` fails | `EncryptUtils.decode()` → success |
| Mower status visible | **No** (FormatException, silently dropped) | **Yes** |
| Password AES | Present | Present |

The `encrypt_utils.dart` module is **new in v2.4.0**. In v2.3.8, mower messages are passed directly to `jsonDecode()` which throws a `FormatException` on the ciphertext, and the exception is silently caught and dropped.

---

## Charger Firmware v0.4.0 — AES Confirmed

!!! success "Fully reverse-engineered via Ghidra decompilation"
    Charger firmware v0.4.0 has been decompiled and analysed. It uses the **exact same AES-128-CBC scheme** as the mower.


!!! lock "Private section"
    This section contains sensitive security details (encryption keys, credentials,
    vulnerability specifics) and is only available in the private wiki.

