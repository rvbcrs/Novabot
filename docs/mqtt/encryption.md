# MQTT Encryption

## Overview

| Device | Encryption | Direction |
|--------|-----------|-----------|
| Charger | **None** (plain JSON) | Both directions |
| Mower | **AES-128-CBC** | Both directions |

The charger firmware (v0.3.6) sends and receives plain JSON.
The mower encrypts all MQTT messages with AES-128-CBC.

---

## Mower AES-128-CBC Encryption

Discovered via Blutter decompilation of APK v2.4.0 (`encrypt_utils.dart`).

### Key Derivation

| Property | Value |
|----------|-------|
| **Algorithm** | AES-128-CBC |
| **Key formula** | `"abcdabcd1234" + SN.substring(SN.length - 4)` |
| **Key example** | `abcdabcd12340238` (for mower `LFIN2230700XXX`) |
| **IV** | `abcd1234abcd1234` (static, hardcoded) |
| **Padding** | Null-byte padding to 64-byte boundary (NOT PKCS7) |
| **Encoding** | UTF-8 for key and IV |

### Step-by-Step Key Construction

```mermaid
graph LR
    SN[Serial Number<br/>LFIN2230700XXX] -->|Last 4 chars| Suffix[0238]
    Prefix[abcdabcd1234] -->|Concatenate| Key[abcdabcd12340238<br/>16 bytes = AES-128]
    IV_const[abcd1234abcd1234] --> IV[Static IV<br/>16 bytes]
    Key --> AES[AES-128-CBC<br/>Encrypt/Decrypt]
    IV --> AES
```

1. Take device serial number (e.g., `LFIN2230700XXX`)
2. Extract last 4 characters: `0238`
3. Concatenate: `"abcdabcd1234"` + `"0238"` = `"abcdabcd12340238"` (16 bytes)
4. Convert to bytes via UTF-8 → AES-128 key
5. IV = `"abcd1234abcd1234"` (always fixed)

### Source Code (from Blutter decompilation)

```
// encode():
0x76cc9c: r16 = "abcdabcd1234"           // Key prefix (12 chars)
0x76ccb4: r0 = _interpolate()             // "abcdabcd1234${snSuffix}" → 16 chars
0x76ccd8: r0 = Uint8List.fromList()       // Key as bytes
0x76cd84: r0 = Key()                      // encrypt package Key object
0x76cdac: r0 = AES()                      // AES cipher setup
0x76cdb0: r0 = Encrypter()                // Encrypter wrapper
0x76cdcc: r2 = "abcd1234abcd1234"         // IV string (16 chars)
0x76cdd8: r0 = Encrypted.fromUtf8()       // IV object
0x76cde8: r0 = encryptBytes()             // Encrypt!

// In mqtt.dart, decode() call:
0x765bf8: sub x1, x4, #4                  // length - 4
0x765c0c: r0 = substring()                // SN.substring(len-4) = last 4 chars
0x765c18: r0 = decode()                   // EncryptUtils.decode(data, snSuffix)
```

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

The app uses a **different** AES setup for encrypting login passwords:

| Property | Value |
|----------|-------|
| Class | `AesEncryption` in `flutter_novabot/common/aes.dart` |
| Key | `1234123412ABCDEF` (UTF-8, 16 bytes) |
| IV | `1234123412ABCDEF` (same as key) |
| Mode | AES-CBC with PKCS7 padding |
| Output | Base64 encoded |
| Usage | Login, registration, password reset — **NOT for MQTT** |

!!! warning "Two different AES systems"
    - **Password AES**: key/IV = `1234123412ABCDEF`, PKCS7 padding, Base64 output
    - **MQTT AES**: key = `abcdabcd1234` + SN suffix, IV = `abcd1234abcd1234`, null-byte padding

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

## Charger Firmware v0.4.0

The charger firmware v0.4.0 (inactive OTA partition) contains the string `abcdabcd12341234abcdabcd12341234` — suggesting v0.4.0 adds AES encryption for charger MQTT messages too, using the same key prefix scheme.
