"""
test_header.py — shared bootstrap for all unit tests.

Adds the project root to sys.path (so fileio, processing, etc. are importable),
then re-exports ROOT and load for direct use in each test.

Usage:
    from test_header import ROOT, load
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from fileio.obieapp_config import ROOT, load  # noqa: E402

__all__ = ['ROOT', 'load']
