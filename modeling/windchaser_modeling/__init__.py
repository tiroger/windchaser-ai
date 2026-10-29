"""Shared code for the WindChaser modeling notebooks.

Kept separate from the notebooks so it can be unit-tested on synthetic data
(scripts/test_modeling.py) while the notebooks, which need private ride data,
are only compiled in CI.

The physics, rider model and calibration are not reimplemented here: they come
from packages/cycling-analytics, exactly as production runs them.
"""

from __future__ import annotations

import sys
from pathlib import Path

MODELING_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = MODELING_DIR.parent

_ANALYTICS = REPO_DIR / "packages" / "cycling-analytics"
if str(_ANALYTICS) not in sys.path:
    sys.path.insert(0, str(_ANALYTICS))
