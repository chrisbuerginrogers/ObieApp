# ObieApp — Claude Code Instructions

## Project Layout

```
ObieApp/
├── Python/              ← Canonical signal processing & I/O (the source of truth)
│   ├── processing/      ← FRF, convolution, band averaging
│   ├── fileio/          ← TRF, AvC, AvR, WAV, run I/O
│   ├── audioio/         ← Audio device enumeration, streaming, capture
│   ├── plotio/          ← Matplotlib visualization helpers
│   ├── Explore.py       ← Desktop TRF viewer (reference for tool structure)
│   └── Aquire.py        ← Desktop capture tool (reference for tool structure)
└── Web/
    ├── py/              ← PyScript (browser) versions of the Python modules
    ├── js/              ← JavaScript UI logic
    ├── css/             ← Shared stylesheets (theme.css + per-tool)
    └── tools/           ← One subfolder per web tool (explore/, acquire/, convolve/, …)
```

## Rule 1 — Always Use the Python from This Repo

For any new or modified tool — web or desktop — **all signal processing, file I/O, and DSP must come from the existing Python modules** in `Python/` (desktop) or their PyScript equivalents in `Web/py/` (browser).

**Specifically:**

| Need | Use |
|---|---|
| FRF / H1 estimation | `Python/processing/frf.py` → `FRFAccumulator`, `add_hit`, `compute_frf` |
| Convolution | `Python/processing/convolution.py` → `convolve_it`, `convolve_with_frf` |
| Band averaging | `Python/processing/bands.py` → `compute_bands` |
| TRF / AvC / AvR / WAV parsing | `Python/fileio/` or `Web/py/files.py` |
| Audio device / streaming | `Python/audioio/` |
| Visualization (desktop) | `Python/plotio/` |
| Browser-side DSP | `Web/py/dsp.py` |
| Browser-side capture state machine | `Web/py/acquire_logic.py` |
| Browser-side config (IndexedDB) | `Web/py/config.py` |

**Do not reimplement** convolution, FRF, band math, or file parsing from scratch. Import or adapt from the modules above.

### When You Cannot Use the Repo Python

If a requirement genuinely cannot be satisfied by the existing modules (e.g., a new file format not in `fileio/`, a browser API with no Python equivalent), **stop and tell the human explicitly**:

> ⚠️ This feature requires something not in the existing Python modules: [description]. Options: [A] extend Python/… [B] use a browser-only approach. Which do you prefer?

Never silently reach for a third-party library or reimplement existing logic.

---

## Rule 2 — All Tools Must Match the Explore / Acquire / Convolve Look & Feel

Every new web tool under `Web/tools/<tool-name>/` must follow the exact same structure as the existing three tools.

### Required HTML shell

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <script src="../../coi-serviceworker.js"></script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[Tool Name] — ObieWebApp 2</title>

  <link rel="stylesheet" href="../../css/theme.css">
  <link rel="stylesheet" href="../../css/[tool-name].css">

  <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>

  <!-- PyScript 2026.3.1 -->
  <link  rel="stylesheet" href="https://pyscript.net/releases/2026.3.1/core.css">
  <script type="module"   src="https://pyscript.net/releases/2026.3.1/core.js"></script>

  <!-- Shared JS — order matters -->
  <script src="../../js/plotly-theme.js"></script>
  <script src="../../js/audio.js"></script>
  <script src="../../js/obie-settings.js"></script>
  <script src="../../js/browser-check.js"></script>       <!-- Chrome check -->
  <script src="../../js/[tool-name].js" defer></script>
</head>
<body>

<div id="loading" class="loading-overlay">
  <div class="spin"></div>
  <div class="load-title">Loading PyScript + NumPy…</div>
  <div class="load-sub">First load may take 15–30 s</div>
</div>

<div class="[tool]-page">

  <!-- Header -->
  <header class="obie-header">
    <a class="brand" href="../../index.html">
      <div class="logo-icon">🎻</div>
      <h1>ObieWebApp 2</h1>
    </a>
    <span class="crumb">· [Tool Name]</span>
    <div class="gap"></div>
    <a class="btn" href="../../index.html" style="font-size:0.75rem;padding:3px 9px">← All tools</a>
  </header>

  <!-- Toolbar — Data Folder button is ALWAYS first -->
  <div class="[tool]-toolbar">
    <button id="[tool]-folder-btn" class="tb-btn" onclick="[tool]SetDataFolder()">📁 Data Folder</button>
    <span id="folder-name-ind" class="folder-name-disp"></span>
    <div class="tb-flex"></div>
    <!-- tool-specific buttons here -->
  </div>

  <!-- Body: sidebar + resizer + plot area (omit sidebar if not needed) -->
  <div class="[tool]-body">
    <!-- ... -->
  </div>

</div>

<script type="py" src="./main.py" config="./pyscript.toml" async></script>
</body>
</html>
```

### Required UI conventions

- **Loading overlay**: always present — same spinner + "Loading PyScript + NumPy…" text.
- **Header**: always `obie-header` class with 🎻 logo, "ObieWebApp 2", tool breadcrumb, and "← All tools" link.
- **Toolbar buttons**: use class `tb-btn`; accent/primary action uses class `tb-btn accent` or `tb-btn start`.
- **Status text**: use `<span class="ex-status-txt">` or similar `*-status-txt` class, not raw paragraphs.
- **Modals**: follow the `modal-overlay → modal-box → modal-header / modal-body` pattern from Explore.
- **Sidebar + resizer**: use the `<div id="[tool]-resizer" class="[tool]-resizer">` drag-handle pattern when a sidebar is present.
- **PyScript version**: always `2026.3.1` — do not upgrade without asking the human.
- **Plotly version**: always `plotly-2.32.0.min.js` — do not upgrade without asking.

---

## Rule 3 — Chrome Check (Automatic)

`browser-check.js` must be included in every tool's `<head>` (see shell above). It alerts the user if they are not on Chrome or Edge, which is required for the File System Access API and SharedArrayBuffer.

Do **not** inline this logic or duplicate it — always load the shared `../../js/browser-check.js`.

---

## Rule 4 — Data Folder Check (Ask the Human First)

Before implementing any file-loading feature in a new tool, **ask the human**:

> Should this tool include a "📁 Data Folder" button so the user can pick a folder and browse/search files within it (like Explore does), or will files be loaded one at a time via individual file pickers (like Convolve)?

- If yes → add the `📁 Data Folder` toolbar button as the first element, wired to `window.showDirectoryPicker()`, and implement folder scanning consistent with `explore.js`.
- If no → use individual `<input type="file">` pickers as in Convolve.

**Never assume** — always ask before wiring up folder access.

---

## Startup Checks (Desktop Python Tools)

Every desktop Python tool must perform these checks before doing any real work, following `Aquire.py` and `Explore.py`:

1. Load config via `fileio/config.py → load()` — fail loudly if `config.json` is missing.
2. Validate any input file paths before opening them.
3. Enumerate audio devices via `audioio.AudioStream.list_input_devices()` if audio is needed.

---

## File Format Reference

| Extension | Parser |
|---|---|
| `.trf` / `.trv` | `Python/fileio/trf_fileio.py` · `Web/py/files.py` |
| `.avc` | `Python/fileio/avc_fileio.py` · `Web/py/files.py` |
| `.avr` | `Python/fileio/avc_fileio.py` · `Web/py/files.py` |
| `.wav` | `Python/fileio/wavfileio.py` · `Web/py/dsp.py` |
| `.tsv` / `.csv` | `Web/py/tsv_parser.py` · `Web/py/files.py` |

All parsers return a standard dict `{freq, mag, header, warnings}` — match that contract when adding new formats.

---

## Data Folder — Shared Handle Pattern

All tools share a single data-folder handle stored in the `ObieWebApp` IndexedDB and `obieDataFolderName` localStorage key via two functions in `Web/js/obie-settings.js`:

```javascript
await saveDataFolderHandle(handle);   // write — called when any tool picks a folder
const handle = await loadDataFolderHandle();  // read — called on every tool startup
```

**Rules:**
- Every tool's startup must call `loadDataFolderHandle()` to restore the last folder. Never read from a tool-private IDB for the folder handle.
- Every tool's folder-picker must call `saveDataFolderHandle(handle)` after a successful pick. This keeps all tools in sync.
- Tools may keep their own `localStorage` key (e.g., `obieExplore_folderName`) as a display cache, but the authoritative handle always comes from the shared store.
- `_IDB` (a tool-private IndexedDB) is only for data that belongs exclusively to that tool, such as Explore's `'wavData'` sound snippet. Never store `'dataFolderHandle'` in a private IDB.

**New folder detection:**
`openObieAppSettings(dirHandle)` returns `{ settingsHandle, templatesHandle, bandsHandle, colorsHandle, isNew }`. When `isNew` is true, show:
> "This is a new Data Folder and I moved over the default settings folder."

Call `openObieAppSettings` wherever a folder is applied (home page, Explore, Acquire) so this alert fires consistently.

---

## CSS / Theming

- Global design tokens live in `Web/css/theme.css` — do not hardcode colours or font sizes.
- Each tool gets its own stylesheet (e.g., `explore.css`, `convolve.css`) for layout-specific rules only.
- Shared component styles (modals, toolbars, sidebars) go in `theme.css`, not per-tool files.
