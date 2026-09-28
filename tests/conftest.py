"""Put the plugin root on sys.path — Hermes loads this package by file path, and these
tests must import it the same way the host does."""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
