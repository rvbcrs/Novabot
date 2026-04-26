#!/usr/bin/env python3
"""
Test that /decision_assistant/robot_out_working_zone publishes Bool (not UInt8).

Phase 2 Task 2.3 confirmation test.
Phase 1 refactor already changed the publisher to Bool.
"""
from pathlib import Path

DA = Path(__file__).resolve().parents[1] / 'decision_assistant.py'


def test_out_of_zone_uses_bool_msg():
    """Verify robot_out_working_zone publisher uses Bool, not UInt8."""
    src = DA.read_text()
    # publisher type — Bool is correct
    assert "Bool, '/decision_assistant/robot_out_working_zone'" in src
    # negative — old UInt8 type should be gone
    assert "UInt8, '/decision_assistant/robot_out_working_zone'" not in src
