"""AES-128-CBC encrypt/decrypt for Novabot MQTT payloads.

Protocol parity:
- Algorithm: AES-128-CBC
- Key: "abcdabcd1234" + SN[-4:] (e.g. "abcdabcd12340238" for LFIN...0238)
- IV: "abcd1234abcd1234" (static)
- Padding: null-bytes to 16-byte boundary (NOT PKCS7)

Authoritative source: CLAUDE.md "AES Encryptie" section.
Validation: research/documents/mqtt_node-aes-validation.md (RE-8).

Per-SN bypass flag is a debug knob — when enabled, encrypt/decrypt
become identity functions. Production deployments leave bypass off.
"""
from __future__ import annotations
from typing import Dict
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

_IV = b'abcd1234abcd1234'
_BYPASS: Dict[str, bool] = {}


def derive_key(sn: str) -> bytes:
    """Per-SN AES key. SN must be at least 4 chars."""
    if len(sn) < 4:
        raise ValueError(f'SN too short for key derivation: {sn!r}')
    return ('abcdabcd1234' + sn[-4:]).encode('utf-8')


def set_bypass(sn: str, enabled: bool) -> None:
    """Toggle plain-text mode for the given SN. Encrypt/decrypt become
    identity when bypass is on. Useful for protocol debugging."""
    _BYPASS[sn] = bool(enabled)


def is_bypass(sn: str) -> bool:
    return _BYPASS.get(sn, False)


def _pad(data: bytes) -> bytes:
    """Null-byte pad to next 16-byte boundary."""
    pad = (-len(data)) % 16
    return data + b'\x00' * pad


def encrypt(sn: str, plaintext: bytes) -> bytes:
    if is_bypass(sn):
        return plaintext
    key = derive_key(sn)
    cipher = Cipher(algorithms.AES(key), modes.CBC(_IV),
                    backend=default_backend())
    enc = cipher.encryptor()
    return enc.update(_pad(plaintext)) + enc.finalize()


def decrypt(sn: str, ciphertext: bytes) -> bytes | None:
    """Returns plaintext bytes (with trailing null-bytes stripped) or
    None if the ciphertext length is not a valid AES block multiple."""
    if is_bypass(sn):
        return ciphertext
    if len(ciphertext) == 0 or len(ciphertext) % 16 != 0:
        return None
    key = derive_key(sn)
    cipher = Cipher(algorithms.AES(key), modes.CBC(_IV),
                    backend=default_backend())
    dec = cipher.decryptor()
    pt = dec.update(ciphertext) + dec.finalize()
    return pt.rstrip(b'\x00')
