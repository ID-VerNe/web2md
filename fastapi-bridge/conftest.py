"""pytest conftest — 确保本模块可导入。"""
from __future__ import annotations

import sys
from pathlib import Path

DIR = Path(__file__).resolve().parent
if str(DIR) not in sys.path:
    sys.path.insert(0, str(DIR))