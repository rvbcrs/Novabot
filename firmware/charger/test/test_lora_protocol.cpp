#include <unity.h>
#include <string.h>

// Minimal test stubs for running on host
#include "../include/lora_protocol.h"

void test_xor_checksum() {
    uint8_t data[] = {0x34, 0x01};
    uint8_t result = loraXorChecksum(data, 2);
    TEST_ASSERT_EQUAL_HEX8(0x35, result);
}

void test_build_heartbeat_packet() {
    uint8_t packet[32];
    uint8_t payload[] = {0x34, 0x01};

    size_t len = loraBuildPacket(packet, sizeof(packet),
                                 0x00, 0x03,
                                 payload, 2);

    // Expected: [02 02 00 03 03 34 01 35 03 03]
    TEST_ASSERT_EQUAL(10, len);
    TEST_ASSERT_EQUAL_HEX8(0x02, packet[0]);
    TEST_ASSERT_EQUAL_HEX8(0x02, packet[1]);
    TEST_ASSERT_EQUAL_HEX8(0x00, packet[2]);
    TEST_ASSERT_EQUAL_HEX8(0x03, packet[3]);
    TEST_ASSERT_EQUAL_HEX8(0x03, packet[4]); // len+1 = 2+1 = 3
    TEST_ASSERT_EQUAL_HEX8(0x34, packet[5]);
    TEST_ASSERT_EQUAL_HEX8(0x01, packet[6]);
    TEST_ASSERT_EQUAL_HEX8(0x35, packet[7]); // XOR(0x34, 0x01) = 0x35
    TEST_ASSERT_EQUAL_HEX8(0x03, packet[8]);
    TEST_ASSERT_EQUAL_HEX8(0x03, packet[9]);
}

void test_parse_heartbeat_packet() {
    // Packet from docs: [02 02 00 03 03 34 01 35 03 03]
    uint8_t raw[] = {0x02, 0x02, 0x00, 0x03, 0x03, 0x34, 0x01, 0x35, 0x03, 0x03};
    uint8_t payload[32];

    size_t payloadLen = loraParsePacket(raw, sizeof(raw), payload, sizeof(payload));

    TEST_ASSERT_EQUAL(2, payloadLen);
    TEST_ASSERT_EQUAL_HEX8(0x34, payload[0]);
    TEST_ASSERT_EQUAL_HEX8(0x01, payload[1]);
}

void test_parse_bad_checksum() {
    // Same packet but with wrong checksum
    uint8_t raw[] = {0x02, 0x02, 0x00, 0x03, 0x03, 0x34, 0x01, 0xFF, 0x03, 0x03};
    uint8_t payload[32];

    size_t payloadLen = loraParsePacket(raw, sizeof(raw), payload, sizeof(payload));
    TEST_ASSERT_EQUAL(0, payloadLen); // Should fail
}

void test_build_buffer_too_small() {
    uint8_t packet[4]; // Too small
    uint8_t payload[] = {0x34, 0x01};

    size_t len = loraBuildPacket(packet, sizeof(packet), 0x00, 0x03, payload, 2);
    TEST_ASSERT_EQUAL(0, len); // Should fail
}

int main(int argc, char** argv) {
    UNITY_BEGIN();
    RUN_TEST(test_xor_checksum);
    RUN_TEST(test_build_heartbeat_packet);
    RUN_TEST(test_parse_heartbeat_packet);
    RUN_TEST(test_parse_bad_checksum);
    RUN_TEST(test_build_buffer_too_small);
    return UNITY_END();
}
