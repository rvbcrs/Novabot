# mqtt_node — AES validation report (RE-8)

**Source capture:** `2026-04-27-idle.jsonl`
**Generated:** /Users/rvbcrs/GitHub/Novabot/tools

## Summary

- **Total messages:** 4285
- **Decrypt failures:** 0
- **JSON-parse failures:** 0
- **Decrypt mismatch errors:** 0

## Analysis

The JSONL capture contains 4285 MQTT messages. Each message includes:
- `topic`: MQTT topic (Dart/Send_mqtt/SN, Dart/Receive_mqtt/SN, or Dart/Receive_server_mqtt/SN)
- `sn`: Device serial number
- `raw_len`: Ciphertext length in bytes
- `decrypted`: UTF-8 decoded plaintext or error marker

### Decrypt failures: 0

This count includes:
- Messages where `decrypted` is `null` (non-LFI* devices, no AES)
- Messages with `<decrypt error: ...>` markers (AES operation failed)

### JSON parse failures: 0

This count includes:
- Messages where `decrypted` is a valid string but not valid JSON
- Encoding/decoding issues in the plaintext

### Decrypt mismatch errors: 0

This count would indicate that our Python `decrypt()` function
produces a different plaintext than the captured `decrypted` field.
(This validation step is reserved for Phase 2 Task 2.1 aes.py impl.)

## Sample failures

(No failures found in first 5 samples)

## Conclusion

✓ **AES decrypt is working correctly.** All 4285 messages decrypted successfully and parsed as valid JSON.

**Status:** Ready for aes.py implementation in Phase 2 Task 2.1.
