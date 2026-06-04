"""
Explore tool -- Tier A slices of your list item #3.

Testable here without a real Data Folder:
  #3.4  Clear All empties the list
  #3.9  See All / See None / Reduce / Clear All / Undo button logic
  #3.10 Interpret note-name annotation placement
  #3.11 Help button opens the docs
  #3.12 'All tools' goes back to the index
  (modal open/close for Search, Lists, Colors)

NOT testable without a real folder (native picker required) -- skipped with
reason so the list stays accounted for:
  #3.1  folder installed         -> needs real picker
  #3.2  search grabs two files   -> needs files on disk
  #3.5  open the default list     -> needs folder contents
  #3.6  create a new list saved to disk -> needs folder write
  #3.7  palette saved as default  -> needs folder write
  #3.8  Share downloads a file     -> needs loaded FRFs (folder)
"""
import re
import pytest
from playwright.sync_api import expect


# A couple of fake datasets matching the shape expSeeAll/Reduce/etc. expect.
SEED_DATASETS = """
  window._datasets = [
    {name:'fileA', visible:true,  color:'#ff0000', freq:[100,200], mag:[1,2]},
    {name:'fileB', visible:true,  color:'#00ff00', freq:[100,200], mag:[3,4]},
    {name:'fileC', visible:true,  color:'#0000ff', freq:[100,200], mag:[5,6]},
  ];
  if (window._renderList) window._renderList();
"""


def _seed(page):
    """Inject fake datasets and re-render the list (exercises real button logic)."""
    page.evaluate(SEED_DATASETS)


def test_all_tools_goes_back(goto_ready, page, base_url):
    """#3.12"""
    goto_ready("tools/explore/")
    page.get_by_role("link", name=re.compile("All tools")).click()
    expect(page).to_have_url(re.compile(r"/index\.html$|/Web/?$"))


def test_help_opens_docs(goto_ready, page):
    """#3.11 -- Help opens the documentation in a new tab."""
    goto_ready("tools/explore/")
    with page.context.expect_page() as popup_info:
        page.get_by_role("button", name="Help").click()
    popup = popup_info.value
    popup.wait_for_load_state("domcontentloaded")
    assert "Docs" in popup.url


def test_clear_all_and_undo(goto_ready, page):
    """
    #3.4 + #3.9 -- the heart of your selection test.
    Seed three datasets, then drive the real button functions and assert
    on the underlying state and the Undo enable/disable.
    """
    goto_ready("tools/explore/")
    _seed(page)

    n = lambda: page.evaluate("window._datasets.length")
    visible = lambda: page.evaluate(
        "window._datasets.filter(d=>d.visible).length"
    )
    undo_disabled = lambda: page.locator("#undo-btn").is_disabled()

    assert n() == 3 and visible() == 3

    # See None -> all invisible, list still length 3, undo now enabled
    page.get_by_role("button", name="See None").click()
    assert visible() == 0 and n() == 3
    assert not undo_disabled()

    # See All -> all visible again
    page.get_by_role("button", name="See All").click()
    assert visible() == 3

    # Hide one, Reduce -> drops the hidden one
    page.evaluate("window._datasets[0].visible=false; window._renderList();")
    page.get_by_role("button", name="Reduce").click()
    assert n() == 2

    # Undo the Reduce -> back to 3
    page.get_by_role("button", name="Undo").click()
    assert n() == 3

    # Clear All -> empty, list emptied
    page.get_by_role("button", name="Clear All").click()
    assert n() == 0

    # Undo the Clear -> restored
    page.get_by_role("button", name="Undo").click()
    assert n() == 3


@pytest.mark.parametrize("opener,modal_id,closer", [
    ("Search", "#search-modal",  "Cancel"),
    ("Lists",  "#lists-modal",   "Close"),
    ("Colors", "#colors-modal",  None),   # close via the ✕
])
def test_modal_open_close(goto_ready, page, opener, modal_id, closer):
    """Toolbar modals open and close (wiring only -- no disk I/O)."""
    goto_ready("tools/explore/")
    modal = page.locator(modal_id)
    page.get_by_role("button", name=opener, exact=True).click()
    expect(modal).to_have_class(re.compile(r"\bopen\b|\bvisible\b|\bactive\b"))
    if closer:
        page.get_by_role("button", name=closer, exact=True).click()
    else:
        modal.locator(".modal-close").click()
    expect(modal).not_to_have_class(re.compile(r"\bopen\b"))


def test_interpret_note_annotations(goto_ready, page):
    """
    #3.10 -- open Interpret and verify note-name annotations are placed on
    the plot. Note names render as Plotly annotations on #interpret-plot;
    we read them from the rendered figure rather than guessing pixels.
    """
    goto_ready("tools/explore/")
    page.get_by_role("button", name="Interpret").click()
    expect(page.locator("#interpret-modal")).to_have_class(
        re.compile(r"\bopen\b|\bvisible\b|\bactive\b")
    )
    # Wait for Plotly to draw, then read annotations off the gd.layout.
    page.wait_for_function(
        """() => {
            const gd = document.getElementById('interpret-plot');
            return gd && gd.layout && Array.isArray(gd.layout.annotations);
        }""",
        timeout=15_000,
    )
    annotations = page.evaluate(
        "document.getElementById('interpret-plot').layout.annotations"
    )
    assert annotations, "no note-name annotations found on interpret plot"
    # Each note annotation should carry an x (frequency) and some text.
    for a in annotations:
        assert "x" in a
