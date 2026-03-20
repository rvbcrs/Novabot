#ifndef GPS_H
#define GPS_H

#include <stdint.h>
#include <stdbool.h>

/*
 * GPS — UM960 RTK receiver via UART5
 *
 * The UM960 uses NovAtel-compatible binary + NMEA protocol.
 * Configured at 5 Hz (0.2s intervals) for:
 *   - #BESTPOS  (position)
 *   - #BESTVEL  (velocity)
 *   - #PSRDOPA  (DOP values)
 *   - #MATCHEDPOSA (matched position)
 *   - $GNGGA   (NMEA GGA sentence)
 *
 * The STM32 forwards GPS data to X3 via serial sub-commands.
 * No GPS processing on STM32 — just UART relay.
 *
 * Antenna offset (from URDF, new hardware variant):
 *   X = +0.186m (forward from wheel axis)
 *   Z = +0.15m  (above wheel axis)
 */

/* GPS fix quality */
typedef enum {
    GPS_FIX_NONE = 0,
    GPS_FIX_SINGLE = 1,
    GPS_FIX_DGPS = 2,
    GPS_FIX_RTK_FIX = 4,
    GPS_FIX_RTK_FLOAT = 5
} gps_fix_t;

/* Parsed GPS position (from BESTPOS/GGA) */
typedef struct {
    double   latitude;
    double   longitude;
    float    altitude;
    gps_fix_t fix_type;
    uint8_t  num_sats;
    float    hdop;
    float    diff_age;     /* Differential correction age (seconds) */
    bool     valid;
} gps_position_t;

/* Parsed GPS velocity (from BESTVEL) */
typedef struct {
    float    speed_ms;     /* Ground speed (m/s) */
    float    heading_deg;  /* Heading over ground (degrees) */
    float    vertical_ms;  /* Vertical speed (m/s) */
    bool     valid;
} gps_velocity_t;

/* Initialize UART5 for UM960 communication */
void gps_init(void);

/* Process received GPS data (call from main loop) */
void gps_process(void);

/* Get latest position/velocity */
void gps_get_position(gps_position_t *pos);
void gps_get_velocity(gps_velocity_t *vel);

/* Check if RTK fix is available */
bool gps_has_rtk_fix(void);

/* Forward raw NMEA sentence to X3 (via serial_send_frame) */
void gps_forward_gga(void);

/* Forward NovAtel binary messages to X3 */
void gps_forward_bestpos(void);
void gps_forward_bestvel(void);
void gps_forward_psrdopa(void);
void gps_forward_matchedposa(void);

#endif /* GPS_H */
