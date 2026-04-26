"""Shared pytest fixtures for mower/mqtt_node tests."""
import sys
from pathlib import Path

# Put the package on sys.path so `from aes import ...` etc. work the
# same way they do under the real on-mower deployment.
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))
