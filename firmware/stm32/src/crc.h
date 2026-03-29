#ifndef CRC_H
#define CRC_H

#include <stdint.h>

/* CRC-8/ITU-T (polynomial 0x07, init 0x00) — used for serial protocol */
void     crc_init(void);
uint8_t  crc8_calc(const uint8_t *data, uint32_t len);

/* CRC-32 (polynomial 0x04C11DB7) — used for IAP firmware update only */
uint32_t crc32_calc(const uint8_t *data, uint32_t len);

#endif /* CRC_H */
