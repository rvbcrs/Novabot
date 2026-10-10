#!/usr/bin/env python3
"""verify_pin in research/extended_commands.py says why a remote unlock failed.

Field report (custom-45, MCU v3.6.0 NewMotor): the serial verify got no CMD
0x23 reply and the server could not tell that apart from a wrong PIN. The
result codes stay as they were (0 verified, 1 refused, 2 no answer / serial
error); the reason field tells the cases apart, and a missing answer carries a
hint about older MCU firmware.

No serial port needed: stm32_serial is replaced by a fake. Run:
    python3 research/__tests__/test_pin_verify.py
"""
import importlib.util
import os
from contextlib import contextmanager

spec = importlib.util.spec_from_file_location(
    "ec", os.path.join(os.path.dirname(__file__), "..", "extended_commands.py"))
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)


class FakeSerial:
    """Answers with the given bytes once, then stays silent."""

    def __init__(self, reply=b""):
        self.reply = reply
        self.written = []

    def write(self, data):
        self.written.append(bytes(data))

    def read(self, n):
        out, self.reply = self.reply[:n], self.reply[n:]
        return out


def run_verify(pin, reply):
    """serial_pin_verify against a fake MCU; returns (result, frames written)."""
    port = FakeSerial(reply)

    @contextmanager
    def fake_serial(kill_chassis=True):
        yield port

    saved = (ec.stm32_serial, ec.PIN_VERIFY_READ_S, ec.serial_clear_error, ec.time.sleep)
    ec.stm32_serial = fake_serial
    ec.PIN_VERIFY_READ_S = 0.05
    ec.serial_clear_error = lambda: {"result": 0, "status": "cleared"}
    ec.time.sleep = lambda s: None
    try:
        return ec.serial_pin_verify(pin), port.written
    finally:
        ec.stm32_serial, ec.PIN_VERIFY_READ_S, ec.serial_clear_error, ec.time.sleep = saved


def mcu_answer(status):
    """A CMD 0x23 reply frame as the MCU sends it (payload: status + 4 digits)."""
    return ec.build_serial_frame(0x23, bytes([status]) + b"1234")


def test_no_answer_is_its_own_reason_with_a_firmware_hint():
    result, written = run_verify("1234", b"")
    assert written and written[0][5] == 0x23 and written[0][6] == 0x02, "type=2 verify frame not sent"
    assert result["result"] == 2
    assert result["error"] == "no_response"      # what older server code keyed on
    assert result["reason"] == "mcu_no_answer"
    assert "v3.6.0" in result["hint"] and "v3.6.2" in result["hint"]


def test_unrelated_traffic_is_still_no_answer():
    # The MCU keeps sending its periodic CMD 0x20 report; that is not an answer.
    noise = ec.build_serial_frame(0x20, bytes([0x00, 0x00]))
    result, _ = run_verify("1234", noise * 3)
    assert result["reason"] == "mcu_no_answer"


def test_wrong_pin():
    result, _ = run_verify("1234", mcu_answer(3))
    assert result == {"result": 1, "status": "wrong_pin", "reason": "wrong_pin"}


def test_unexpected_status():
    result, _ = run_verify("1234", mcu_answer(7))
    assert result["result"] == 1 and result["reason"] == "unexpected_answer"


def test_verified_keeps_the_old_shape():
    for status in (0, 2):
        result, _ = run_verify("1234", mcu_answer(status))
        assert result == {"result": 0, "status": "verified"}, result


def test_bad_pin_never_reaches_the_port():
    result, written = run_verify("12a4", b"")
    assert result["result"] == 1 and result["reason"] == "invalid_pin"
    assert written == []


def test_serial_failure():
    @contextmanager
    def broken(kill_chassis=True):
        raise OSError("could not open port /dev/ttyACM0")
        yield  # pragma: no cover

    saved = ec.stm32_serial
    ec.stm32_serial = broken
    try:
        result = ec.serial_pin_verify("1234")
    finally:
        ec.stm32_serial = saved
    assert result["result"] == 2 and result["reason"] == "serial_error"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all pin-verify checks passed")
