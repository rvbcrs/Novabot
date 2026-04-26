"""AES-128-CBC round-trip + parity tests.

Cite: CLAUDE.md "AES Encryptie" section + research/documents/
mqtt_node-aes-validation.md (RE-8 confirms our Python AES matches the
server's TypeScript decrypt and the stock binary).
"""
import pytest
from aes import encrypt, decrypt, derive_key, set_bypass


def test_key_derivation_matches_claude_md():
    # CLAUDE.md: "abcdabcd1234" + SN[-4:]
    assert derive_key('LFIN2230700238') == b'abcdabcd12340238'
    assert derive_key('LFIC1230700004') == b'abcdabcd12340004'


def test_round_trip_short():
    sn = 'LFIN1231000211'
    plaintext = b'{"hello": "world"}'
    ciphertext = encrypt(sn, plaintext)
    assert ciphertext != plaintext
    assert len(ciphertext) % 16 == 0
    recovered = decrypt(sn, ciphertext)
    assert recovered == plaintext


def test_round_trip_with_padding_strip():
    sn = 'LFIN1231000211'
    # 17 bytes — needs padding to 32
    plaintext = b'12345678901234567'
    ciphertext = encrypt(sn, plaintext)
    assert len(ciphertext) == 32
    # Decrypt should strip null-byte pad (NOT PKCS7)
    assert decrypt(sn, ciphertext) == plaintext


def test_bypass_mode_per_sn():
    sn = 'LFIN1231000211'
    set_bypass(sn, True)
    assert encrypt(sn, b'hello') == b'hello'
    assert decrypt(sn, b'hello') == b'hello'
    set_bypass(sn, False)
    assert encrypt(sn, b'hello') != b'hello'


def test_decrypt_invalid_length_returns_none():
    # Length not multiple of 16 → cannot be valid ciphertext
    assert decrypt('LFIN1231000211', b'short') is None
