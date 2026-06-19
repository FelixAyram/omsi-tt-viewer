#!/usr/bin/env python3
"""Alias: ejecuta la suite completa Selenium OMSI."""

import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    script = Path(__file__).resolve().parent / "test_selenium_omsi.py"
    sys.exit(subprocess.call([sys.executable, str(script), *sys.argv[1:]]))
