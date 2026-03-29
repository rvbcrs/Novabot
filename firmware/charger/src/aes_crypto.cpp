#include "aes_crypto.h"
#include "config.h"
#include <mbedtls/aes.h>
#include <string.h>

// Build the 16-byte AES key: "abcdabcd1234" + last 4 chars of SN
static void buildKey(const char* sn, uint8_t key[16]) {
    size_t snLen = strlen(sn);
    memcpy(key, AES_KEY_PREFIX, 12);
    if (snLen >= 4) {
        memcpy(key + 12, sn + snLen - 4, 4);
    } else {
        // Fallback: pad with zeros (should never happen with valid SN)
        memset(key + 12, 0, 4);
        memcpy(key + 12, sn, snLen);
    }
}

size_t aesEncrypt(const char* sn, const uint8_t* input, size_t inputLen,
                  uint8_t* output, size_t outputBufSize) {
    if (!sn || strlen(sn) < 4 || inputLen == 0) return 0;

    // Pad to 16-byte boundary with null bytes
    size_t paddedLen = ((inputLen + 15) / 16) * 16;
    if (paddedLen > outputBufSize) return 0;

    // Prepare padded input (null-byte padding, NOT PKCS7)
    uint8_t padded[1024];
    if (paddedLen > sizeof(padded)) return 0;
    memset(padded, 0, paddedLen);
    memcpy(padded, input, inputLen);

    uint8_t key[16];
    buildKey(sn, key);

    // Fresh IV copy — mbedtls modifies IV in-place during CBC
    uint8_t iv[16];
    memcpy(iv, AES_IV, 16);

    mbedtls_aes_context ctx;
    mbedtls_aes_init(&ctx);
    mbedtls_aes_setkey_enc(&ctx, key, 128);
    int ret = mbedtls_aes_crypt_cbc(&ctx, MBEDTLS_AES_ENCRYPT, paddedLen, iv, padded, output);
    mbedtls_aes_free(&ctx);

    return (ret == 0) ? paddedLen : 0;
}

size_t aesDecrypt(const char* sn, const uint8_t* input, size_t inputLen,
                  uint8_t* output, size_t outputBufSize) {
    if (!sn || strlen(sn) < 4) return 0;
    if (inputLen < 16 || inputLen % 16 != 0) return 0;
    if (inputLen > outputBufSize) return 0;

    uint8_t key[16];
    buildKey(sn, key);

    // Fresh IV copy
    uint8_t iv[16];
    memcpy(iv, AES_IV, 16);

    mbedtls_aes_context ctx;
    mbedtls_aes_init(&ctx);
    mbedtls_aes_setkey_dec(&ctx, key, 128);
    int ret = mbedtls_aes_crypt_cbc(&ctx, MBEDTLS_AES_DECRYPT, inputLen, iv, input, output);
    mbedtls_aes_free(&ctx);

    if (ret != 0) return 0;

    // Strip null-byte padding
    size_t end = inputLen;
    while (end > 0 && output[end - 1] == 0) end--;

    return end;
}
