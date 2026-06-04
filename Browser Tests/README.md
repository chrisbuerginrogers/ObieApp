# ObieWebApp — Tier-A browser tests

End-to-end browser tests (Playwright + pytest) for the button/UI behavior of
ObieWebApp. These complement your existing Python unit tests of the DSP/file
logic — they do **not** re-test the math.

## What's covered, and what isn't

The app has three hard constraints for browser testing:

1. **PyScript boot** — the page runs Python in WebAssembly and takes 15–30 s to
   become interactive. Every test waits on the real readiness signal (the
   `#loading` overlay gaining `.gone`) before doing anything.
2. **File System Access API** — the Data Folder uses a native OS folder picker
   that no browser-automation tool can drive. Anything that reads/writes the
   folder is out of reach for a normal browser test.
3. **Audio / hardware** — real sound output and mic/acquisition input can't be
   verified by a headless browser.

So the tests fall into tiers:

| Tier | Meaning | Status |
|------|---------|--------|
| **A** | Drivable in a headless browser, no folder/audio/hardware | **Implemented** |
| **B** | Needs a Data Folder — would require a mocked/injected filesystem in the app | Skipped, with reason |
| **C** | Needs real audio output or acquisition hardware | Skipped, with reason |

Every item from the original test list is represented: Tier-A items are real
tests; Tier-B/C items are `@pytest.mark.skip` with a one-line reason, so nothing
is silently dropped. The skipped file-format/numbering checks (#5.7, list/palette
saving) are the ones your existing Python unit tests already cover better.

### Tier-A coverage by original item

- **#2** version number — `test_index.py` (plus a guard that re-reads
  `version.js` so the test fails loudly when you bump the version)
- **#1** create-folder modal open/close (wiring only) — `test_index.py`
- **#3.4 / #3.9** See All / See None / Reduce / Clear All / Undo — `test_explore.py`
  (seeds fake datasets via `page.evaluate`, then drives the real button
  functions and asserts on state + the Undo enable/disable)
- **#3.10** Interpret note-name annotations — `test_explore.py` (reads Plotly
  annotations off the rendered figure)
- **#3.11** Help opens docs — `test_explore.py`
- **#3.12** All-tools back button — `test_explore.py`
- Search / Lists / Colors modal open-close — `test_explore.py`
- **#4.1** load L+R FRFs, plots appear — `test_convolve.py`
- **#4.2** convolve, result plots appear — `test_convolve.py`
- **#4.5** Lin/Log frequency toggle — `test_convolve.py`
- **#4.6** Show L/R toggle — `test_convolve.py`
- **#5.1** simulated-input device available — `test_acquire.py`
- Acquire boots, X-axis toggle, Settings modal — `test_acquire.py`

The convolve file tests use real fixtures (two Strad `.AvC` files + a `.wav`)
in `tests/fixtures/`, loaded through the page's real `<input type=file>`
elements — which Playwright *can* drive directly (no native dialog involved).

## Setup

Use a dedicated virtual environment for these tests. Playwright pins its own
browser binaries and the `pytest-playwright` plugin; keeping that isolated stops
it from interfering with the environment you use for the app's own Python/DSP
code.

**macOS / Linux:**

```bash
cd obie-browser-tests          # the folder this README is in
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium    # the app needs a Chrome/Edge-family browser
```

**Windows (PowerShell):**

```powershell
cd obie-browser-tests
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
playwright install chromium
```

You'll know the venv is active when your prompt shows `(.venv)`. Activate it
again in any new terminal before running the tests (the `source ...` /
`Activate.ps1` line). When you're done, run `deactivate` to leave it.

The `.venv/` folder can be deleted and recreated anytime, and should be excluded
from version control (add `.venv/` to your `.gitignore`).

> Note: in CI the venv is unnecessary — each GitHub Actions run starts from a
> clean machine — so `.github/workflows/browser-tests.yml` installs directly.

## Run

Against the live site (default):

```bash
pytest
```

Against a local copy of the site:

```bash
# from your repo's Web/ parent, e.g.:
python -m http.server 8000
OBIE_BASE_URL=http://localhost:8000/Web pytest
```

Useful flags while developing:

```bash
pytest --headed            # watch it in a real window
pytest --slowmo 300        # slow each action down
pytest -k convolve         # run one tool's tests
pytest tests/test_explore.py::test_clear_all_and_undo
```

## Notes / gotchas

- **First run is slow.** PyScript cold-boot dominates; the readiness timeout is
  60 s per page in `conftest.py`. Subsequent loads are faster (browser cache).
- **Chromium only.** The app gates on Chrome/Edge for the File System Access and
  audio APIs, so don't run `--browser firefox/webkit`.
- **Selectors** are the app's stable `id`s and button text. If you rename a
  button or an `onclick` handler, update the matching test.
- **Extending into Tier B.** To test the folder-dependent items (lists, palette
  save, file numbering, full acquisition), the practical route is to add a test
  hook in the app that swaps the real directory handle for an in-memory mock,
  then assert on what the app *wrote* to that mock. That's an app change, not a
  test-only change — out of scope here but the natural next step.
