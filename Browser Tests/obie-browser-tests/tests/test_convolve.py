"""
Convolve tool -- list item #4.

Genuinely end-to-end testable here, because the file inputs are real
<input type=file> elements (Playwright sets them directly -- no native
dialog):
  #4.1  load the two strad files (L + R) -> plots appear
  #4.2  hit Convolve -> remaining plots appear (result card shows)
  #4.5  Lin/Log frequency toggle changes the spectrogram axis label/state
  #4.6  Show L/R toggle changes the output spectrogram

NOT testable in a headless browser (skipped with reason):
  #4.3  play the convolution -> can't verify real audio output
  #4.4  save -> is the file playable -> native save + audio playback
"""
import pathlib
import re
import pytest
from playwright.sync_api import expect

FIX = pathlib.Path(__file__).parent / "fixtures"


def _plot_has_traces(page, plot_id):
    return page.evaluate(
        f"""() => {{
            const gd = document.getElementById({plot_id!r});
            return !!(gd && gd.data && gd.data.length > 0);
        }}"""
    )


def test_load_frfs_plots_appear(goto_ready, page):
    """#4.1 -- load L and R FRFs; the FRF magnitude plot draws."""
    goto_ready("tools/convolve/")
    page.locator("#frf-l-input").set_input_files(str(FIX / "titian.avc"))
    page.locator("#frf-r-input").set_input_files(str(FIX / "jackson.avc"))

    # statuses update away from the empty defaults
    expect(page.locator("#frf-l-status")).not_to_have_text("no file loaded")
    expect(page.locator("#frf-r-status")).not_to_have_text("–")

    page.wait_for_function(
        """() => { const gd=document.getElementById('frf-plot');
                   return gd && gd.data && gd.data.length>0; }""",
        timeout=20_000,
    )
    assert _plot_has_traces(page, "frf-plot")


def test_convolve_produces_result(goto_ready, page):
    """#4.2 -- load FRF + WAV, convolve, result card and output plots appear."""
    goto_ready("tools/convolve/")
    page.locator("#frf-l-input").set_input_files(str(FIX / "titian.avc"))
    page.locator("#wav-input").set_input_files(str(FIX / "signal.wav"))
    expect(page.locator("#wav-status")).not_to_have_text("no file loaded")

    page.get_by_role("button", name=re.compile("Convolve")).click()

    # result card is display:none until convolution completes
    expect(page.locator("#result-card")).to_be_visible(timeout=30_000)
    page.wait_for_function(
        """() => { const gd=document.getElementById('out-plot');
                   return gd && gd.data && gd.data.length>0; }""",
        timeout=30_000,
    )
    assert _plot_has_traces(page, "out-plot")


def test_freq_lin_log_toggle(goto_ready, page):
    """#4.5 -- the Freq Lin/Log button flips its label (and the axis state)."""
    goto_ready("tools/convolve/")
    btn = page.locator("#spec-scale-btn")
    expect(btn).to_have_text(re.compile("Freq: Lin"))
    btn.click()
    expect(btn).to_have_text(re.compile("Freq: Log"))
    btn.click()
    expect(btn).to_have_text(re.compile("Freq: Lin"))


def test_show_lr_toggle(goto_ready, page):
    """
    #4.6 -- after convolving (stereo needs both L+R), the Show L/R button on
    the output spectrogram flips the channel label.
    """
    goto_ready("tools/convolve/")
    page.locator("#frf-l-input").set_input_files(str(FIX / "titian.avc"))
    page.locator("#frf-r-input").set_input_files(str(FIX / "jackson.avc"))
    page.locator("#wav-input").set_input_files(str(FIX / "signal.wav"))
    page.get_by_role("button", name=re.compile("Convolve")).click()
    expect(page.locator("#result-card")).to_be_visible(timeout=30_000)

    label = page.locator("#out-spec-label")
    before = label.text_content()
    page.locator("#out-spec-btn").click()
    expect(label).not_to_have_text(before)


@pytest.mark.skip(reason="Tier C: real audio output can't be verified headless (#4.3)")
def test_play_convolution():
    ...


@pytest.mark.skip(reason="Tier C: native save + playback out of scope (#4.4)")
def test_save_convolution_playable():
    ...
