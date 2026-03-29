#pragma once
#include <Arduino.h>

// Encrypt a JSON command for a device (null-byte padding to 16-byte boundary)
// Returns encrypted length, or 0 on failure.
// outputBuf must be at least ((inputLen + 15) / 16) * 16 bytes.
size_t aesEncrypt(const char* sn, const uint8_t* input, size_t inputLen,
                  uint8_t* output, size_t outputBufSize);

// Decrypt an AES-128-CBC payload from a device.
// Returns decrypted length (with null padding stripped), or 0 on failure.
// outputBuf must be at least inputLen bytes.
size_t aesDecrypt(const char* sn, const uint8_t* input, size_t inputLen,
                  uint8_t* output, size_t outputBufSize);
