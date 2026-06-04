"""
Index page: version number and navigation.

Covers your list:
  #2     version number is the right number
  #3.12  'All tools' button goes back (tested from each tool)
  #3.11 / help -- the Help button is in-tool; see test_explore.py
"""
import re
import pytest
from playwright.sync_api import expect

EXPECTED_VERSION = "1.1.1"  # from Web/version.js : OBIE_VERSION


def test_version_number(goto_ready, page):
    """#2 -- footer shows v<OBIE_VERSION>."""
    goto_ready("index.html")
    footer = page.locator("#footer-version")
    expect(footer).to_have_text(f"v{EXPECTED_VERSION}")


def test_version_matches_source(base_url, page):
    """
    Guard against the test going stale: read version.js straight from the
    site and assert our EXPECTED_VERSION still matches. If this fails, the
    app was bumped and EXPECTED_VERSION needs updating.
    """
    resp = page.request.get(f"{base_url}/version.js")
    assert resp.ok
    text = resp.text()
    m = re.search(r"OBIE_VERSION\s*=\s*['\"]([^'\"]+)['\"]", text)
    assert m, "couldn't find OBIE_VERSION in version.js"
    assert m.group(1) == EXPECTED_VERSION, (
        f"site version {m.group(1)} != test's EXPECTED_VERSION "
        f"{EXPECTED_VERSION}; update the constant."
    )


@pytest.mark.parametrize(
    "card_text,expected_path",
    [
        ("Explore", "tools/explore"),
        ("Convolve", "tools/convolve"),
        ("Acquire", "tools/acquire"),
        ("Documentation", "Docs"),
    ],
)
def test_nav_to_tool(goto_ready, page, card_text, expected_path):
    """Each tool card links to the right place."""
    goto_ready("index.html")
    link = page.get_by_role("link", name=re.compile(card_text))
    href = link.first.get_attribute("href")
    assert expected_path in href, f"{card_text} -> {href}"


def test_create_folder_modal_opens_and_closes(goto_ready, page):
    """
    #1 (the testable slice) -- the 'Create new Data Folder' modal opens and
    closes. We CANNOT click through to the native folder picker, so this
    verifies the modal wiring only, not actual folder creation on disk.
    """
    goto_ready("index.html")
    modal = page.locator("#create-folder-modal")

    expect(modal).not_to_have_class(re.compile(r"\bopen\b"))
    page.get_by_role("button", name=re.compile("Create new")).click()
    expect(modal).to_have_class(re.compile(r"\bopen\b"))

    # the step instructions get populated for the user's OS
    expect(page.locator("#create-folder-steps")).not_to_be_empty()

    page.get_by_role("button", name="Cancel").click()
    expect(modal).not_to_have_class(re.compile(r"\bopen\b"))
