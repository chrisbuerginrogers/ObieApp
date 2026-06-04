"""
Shared fixtures for the ObieWebApp Tier-A browser tests.

Tier A = things a headless browser can verify without the native folder
picker, real audio output, or real acquisition hardware:
  - version number
  - navigation between tools and back
  - modal open/close
  - button-driven UI state (select all / clear / undo, axis toggles, etc.)
  - plots appearing in the DOM after an action
  - the interpret note-name annotations

Anything that needs showDirectoryPicker(), real sound, or a mic is NOT here
by design -- those are Tier B/C and can't be driven by a normal browser test.
"""
import os
import pytest

# Point at the live site by default; override to a local server with
#   OBIE_BASE_URL=http://localhost:8000/Web  pytest
BASE_URL = os.environ.get(
    "OBIE_BASE_URL",
    "https://chrisbuerginrogers.github.io/ObieApp/Web",
).rstrip("/")

# PyScript first-load can take 15-30s; give it generous headroom.
APP_READY_TIMEOUT_MS = 60_000


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture
def goto_ready(page):
    """
    Navigate to a tool path (relative to BASE_URL) and block until the
    PyScript app has finished booting.

    Readiness signal: the #loading overlay gets the `.gone` class once
    Python has initialised (confirmed in convolve/acquire main.py and
    explore.js). Tools without an overlay are treated as ready on load.
    """
    def _go(path: str):
        url = f"{BASE_URL}/{path.lstrip('/')}"
        page.goto(url, wait_until="domcontentloaded")
        overlay = page.locator("#loading")
        if overlay.count() > 0:
            # wait for either the .gone class or the element to disappear
            page.wait_for_function(
                """() => {
                    const el = document.getElementById('loading');
                    return !el || el.classList.contains('gone')
                           || getComputedStyle(el).display === 'none';
                }""",
                timeout=APP_READY_TIMEOUT_MS,
            )
        return page
    return _go


@pytest.fixture
def mock_data_folder(page):
    """
    Pretend a Data Folder is connected, WITHOUT touching the native picker.

    The app stores the folder name in localStorage (`obieDataFolderName`).
    This lets us test UI that only checks 'is a folder name present',
    e.g. the folder-name indicator / overlay gating. It does NOT give the
    app a real directory handle, so any test that actually reads or writes
    files will still (correctly) fail -- that's Tier B, out of scope.

    Call the returned function BEFORE navigating.
    """
    def _set(name: str = "TestData"):
        page.add_init_script(
            f"window.localStorage.setItem('obieDataFolderName', {name!r});"
        )
    return _set


def dismiss_dialogs(page):
    """Auto-accept any alert()/confirm() so a stray dialog can't hang a test."""
    page.on("dialog", lambda d: d.accept())
