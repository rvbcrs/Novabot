"""Shared fixtures for non-ROS unit tests in mower/."""
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.fakes import FakeNode  # noqa: E402


@pytest.fixture
def fake_node():
    return FakeNode()
