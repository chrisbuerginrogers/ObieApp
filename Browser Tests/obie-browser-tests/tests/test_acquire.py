"""
Acquire tool -- list item #5.

This is the hardest tool to test: it's gated behind a connected Data Folder
(#folder-overlay), and almost every item needs real/simulated hardware AND
disk writes to verify. What's honestly Tier A:
  - the tool boots and the X-axis log/lin toggle works
  - the Settings (prefs) modal opens
  - the '⚡ Simulated Input' device option exists in the picker (#5.1 slice)

Skipped with reasons (need a real folder, hardware, or disk inspection):
  #5.2  select an instrument          -> instrument overlay needs folder
  #5.3  LiveView / threshold / replace -> live audio + folder
  #5.4  load a template               -> reads template from folder
  #5.5  change/save/reload settings    -> writes settings file to disk
  #5.6  run a full setting, change axes -> simulated capture + disk writes
  #5.7  check AvR/AvC/TRF/WAV numbering -> inspect files written to disk

  -> These belong in a Tier-B harness with a mocked/injected filesystem,
     or stay as your existing Python-side unit tests for the file logic.
"""
import re
import pytest
from playwright.sync_api import expect


def test_acquire_boots(goto_ready, page):
    """Tool loads past PyScript init (the #loading overlay goes away)."""
    goto_ready("tools/acquire/")
    expect(page.locator("#acq-start-btn")).to_be_visible()


def test_x_axis_toggle(goto_ready, page):
    """X=log / X=lin button flips label and 'active' class."""
    goto_ready("tools/acquire/")
    btn = page.locator("#x-log-btn")
    start = btn.text_content()
    btn.click()
    expect(btn).not_to_have_text(start)
    btn.click()
    expect(btn).to_have_text(start)


def test_settings_modal_opens(goto_ready, page):
    """Settings button opens the prefs modal (wiring only, no disk I/O)."""
    goto_ready("tools/acquire/")
    page.get_by_role("button", name="Settings").click()
    expect(page.locator("#prefs-modal")).to_have_class(
        re.compile(r"\bopen\b|\bvisible\b|\bactive\b")
    )


def test_simulated_device_available(goto_ready, page):
    """
    #5.1 (slice) -- the simulated soundcard option exists so acquisition can
    run without hardware. We assert the option is present in the device
    <select>; actually running a simulated session needs a Data Folder.
    """
    goto_ready("tools/acquire/")
    page.get_by_role("button", name="Settings").click()
    options = page.locator("#prefs-device option").all_text_contents()
    assert any("Simulated" in o for o in options), (
        f"no simulated-input option found; got {options}"
    )


@pytest.mark.skip(reason="Tier B: needs a connected Data Folder (#5.2, #5.4)")
def test_instrument_and_template():
    ...


@pytest.mark.skip(reason="Tier C: live audio + replace-on-close prompt (#5.3)")
def test_liveview_threshold():
    ...


@pytest.mark.skip(reason="Tier B: settings written to disk; covered by Python unit tests (#5.5)")
def test_settings_save_reload():
    ...


@pytest.mark.skip(reason="Tier B/C: simulated capture + disk writes (#5.6)")
def test_full_run_axis_changes():
    ...


@pytest.mark.skip(reason="Tier B: file numbering verified by your Python unit tests (#5.7)")
def test_file_numbering_scheme():
    ...
