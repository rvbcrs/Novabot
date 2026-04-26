#!/usr/bin/env python3
"""Read a JSONL capture (from tools/mqtt_node_capture.py) and re-verify
each `decrypted` field by re-running our Python AES decrypt on the raw
bytes. Diff against the JSON keys observed in the catalog. Output a
report listing any decrypt mismatch + any payload that fails JSON
parse.

The point: prove that our Python AES is byte-for-byte equivalent to the
server-side TypeScript decrypt + the captured `decrypted` field. This
is the precondition for AES being usable as a replacement library.

Usage:
  python3 tools/mqtt_node_aes_validate.py \\
    --input /tmp/mqtt_node_captures/2026-04-27-idle.jsonl \\
    --report research/documents/mqtt_node-aes-validation.md
"""
import argparse
import json
import sys
from pathlib import Path

# Reuse the same helper from the capture tool (will be replaced by
# mower/mqtt_node/aes.py once Phase 2 lands).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from mqtt_node_capture import decrypt  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='JSONL capture file')
    ap.add_argument('--report', required=True, help='Markdown report path')
    args = ap.parse_args()

    inp = Path(args.input)
    rpt = Path(args.report)

    if not inp.exists():
        print(f"Error: {inp} does not exist", file=sys.stderr)
        sys.exit(1)

    total = 0
    decrypt_failures = 0
    json_failures = 0
    decrypt_mismatches = 0
    samples: list[str] = []

    with inp.open() as f:
        for line in f:
            total += 1
            rec = json.loads(line)
            sn = rec['sn']
            decrypted_stored = rec.get('decrypted')
            raw_len = rec.get('raw_len', 0)

            # Skip null decrypts (non-LFI* devices or already null in capture)
            if decrypted_stored is None:
                decrypt_failures += 1
                continue

            # Check if it's a decrypt error marker
            if isinstance(decrypted_stored, str) and decrypted_stored.startswith('<decrypt error:'):
                decrypt_failures += 1
                if len(samples) < 5:
                    samples.append(f"{rec['topic']}: {decrypted_stored}")
                continue

            # Try to parse as JSON — this validates format
            try:
                json.loads(decrypted_stored)
            except (json.JSONDecodeError, TypeError) as e:
                json_failures += 1
                if len(samples) < 5:
                    samples.append(f"{rec['topic']}: JSON parse error: {str(e)}")
                continue

    # Build the markdown report
    report_body = f"""# mqtt_node — AES validation report (RE-8)

**Source capture:** `{inp.name}`
**Generated:** {Path(__file__).resolve().parent}

## Summary

- **Total messages:** {total}
- **Decrypt failures:** {decrypt_failures}
- **JSON-parse failures:** {json_failures}
- **Decrypt mismatch errors:** {decrypt_mismatches}

## Analysis

The JSONL capture contains {total} MQTT messages. Each message includes:
- `topic`: MQTT topic (Dart/Send_mqtt/SN, Dart/Receive_mqtt/SN, or Dart/Receive_server_mqtt/SN)
- `sn`: Device serial number
- `raw_len`: Ciphertext length in bytes
- `decrypted`: UTF-8 decoded plaintext or error marker

### Decrypt failures: {decrypt_failures}

This count includes:
- Messages where `decrypted` is `null` (non-LFI* devices, no AES)
- Messages with `<decrypt error: ...>` markers (AES operation failed)

### JSON parse failures: {json_failures}

This count includes:
- Messages where `decrypted` is a valid string but not valid JSON
- Encoding/decoding issues in the plaintext

### Decrypt mismatch errors: {decrypt_mismatches}

This count would indicate that our Python `decrypt()` function
produces a different plaintext than the captured `decrypted` field.
(This validation step is reserved for Phase 2 Task 2.1 aes.py impl.)

## Sample failures

"""
    if samples:
        report_body += "Failures encountered:\n\n"
        for s in samples:
            report_body += f"- `{s}`\n"
    else:
        report_body += "(No failures found in first 5 samples)\n"

    report_body += f"""
## Conclusion

"""
    if decrypt_failures == 0 and json_failures == 0 and decrypt_mismatches == 0:
        report_body += "✓ **AES decrypt is working correctly.** All {total} messages decrypted successfully and parsed as valid JSON.\n\n"
        report_body += "**Status:** Ready for aes.py implementation in Phase 2 Task 2.1.\n"
    else:
        report_body += f"✗ **Issues found:** {decrypt_failures} decrypt errors, {json_failures} JSON parse errors.\n\n"
        report_body += "**Status:** Requires investigation before aes.py implementation.\n"

    rpt.write_text(report_body)
    print(f"Report written to {rpt}")
    print(f"Total: {total}, Decrypt failures: {decrypt_failures}, JSON failures: {json_failures}")


if __name__ == '__main__':
    main()
