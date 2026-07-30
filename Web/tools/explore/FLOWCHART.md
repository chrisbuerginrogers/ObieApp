# Explore — Code Flow

This documents how `explore.js` (JS/UI, Data Folder access, Plotly rendering,
and — notably — all of the FRF math) and `main.py` (PyScript, backed by
`Web/py/files.py` and the canonical `Python/fileio/`/`Python/processing/`
modules) work together. Diagrams render natively on GitHub and in most
Markdown/Mermaid-aware editors.

- JS (`explore.js`) owns: the UI, the Data Folder / File System Access API,
  search/lists/color-palette/preferences state, and — unlike Acquire — the
  actual FRF math shown on screen: smoothing (`_smooth`), normalization
  (`_applyNorm`/`_norm`/`_normByAvg`), group averaging (`_computeAvgTrace`),
  and band averaging (`_computeBands`) are all plain JS, run fresh inside
  `render()` on every redraw.
- Python (`main.py`) owns a narrower slice: dispatching file bytes to the
  canonical parsers in `Web/py/files.py` → `Python/fileio/*` (trf/avc/avr/
  tsv/csv/mat), decoding/caching the default WAV, running the convolution
  preview (`Python/processing/convolution.py`), and building `.avr` bytes
  for the "Group Average → Save as AvR" export (`Python/fileio/avc_fileio.py`
  → `build_avr`).
- The two sides talk through `window.py*` functions (JS → Python, wired at
  the bottom of `main.py`) and `window.on*`/`window.obieExplore*` callbacks
  (Python → JS).

## 1. Overview — one session, start to finish

```mermaid
flowchart TD
    A["Page loads"] --> B["JS restores prefs, plot state, sidebar width, undo stack"]
    B --> C["main.py loads, wires pyExplore* functions, calls obieExploreReady()"]
    C --> D{"Data Folder handle in IndexedDB and permission granted?"}
    D -- yes --> E["_applyFolder(handle) — loads settings, bands, lists, palettes, scans files"]
    D -- no --> F["Show folder-overlay: 'Select a Data Folder'"]
    E --> G["User finds files via Search / Browse / Lists / drag-drop"]
    F --> G
    G --> H["pyExploreLoadFile(name, bytes) -> Python _load_frf -> files.load()"]
    H --> I["obieExploreAddDataset(name, freq, mag, coh, isComplex)"]
    I --> J["_datasets.push(...); _renderList(); render()"]
    J --> K["User adjusts smoothing / normalization / bands / colors / coherence / palette"]
    K --> J
    J --> L["Export: Share (CSV), Save Group Average (CSV/AvR), Print, Save as List"]
```

## 2. Page load / init sequence

`DOMContentLoaded` (JS) and PyScript's `main.py` load independently and
converge once `obieExploreReady()` fires.

```mermaid
flowchart TD
    A["DOMContentLoaded (fires immediately)"] --> B["Plotly.newPlot empty #explore-plot"]
    B --> C["_syncUndoBtn, _renderList, _syncAxisBtns"]
    C --> D["_wireSearchFilters, _setupResizer"]

    E["main.py loads (PyScript, async)"] --> F["configure('obieWebApp_explore', defaults)"]
    F --> G["wires pyExploreLoadFile / pyExploreSetWav /\npyExploreConvolve / pyExploreWriteAv"]
    G --> H["js.window.obieExploreReady()"]
    H --> I["#loading overlay removed ('gone' class)"]
    H --> J["Default WAV fetched: IDB-cached bytes first,\nelse localStorage URL, else sample-data WAV"]
    H --> K["Restore _S from 'obieExplore_prefs' + 'obieExplore_plotState'"]
    K --> L["_S.normMode forced to 'as_measured' every load\n(never carries over 'complex_avg'/'real_avg')"]
    L --> M["_syncControls(); _populateBandSel(); render()"]
    M --> N["_setupHover, _setupContextMenu,\n_setupAvgSaveModal, _setupDropZone"]
    N --> O{"Saved folder name in localStorage\n('obieExplore_folderName' or shared 'obieDataFolderName')?"}
    O -- yes --> P["loadDataFolderHandle() -> h.queryPermission({mode:'read'})"]
    P --> Q{"permission === 'granted'?"}
    Q -- yes --> R["_applyFolder(h)"]
    Q -- no --> S["Leave folder-overlay showing\nthe folder name needs permission — click to reconnect"]
    O -- no --> S
```

## 3. Data Folder — pick, scan, and settings sync

```mermaid
flowchart TD
    A["expSetDataFolder() click"] --> B["window.showDirectoryPicker({mode:'read'})"]
    B --> C["_applyFolder(dir)"]
    C --> D["openObieAppSettings(dir)\ncreates/reuses ObieAppSettings/{Templates,bands,lists,colors}"]
    D --> E{"isNew folder?"}
    E -- yes --> F["alert: 'moved over the default settings folder'\n(+ note if seeding a template/band download failed)"]
    E -- no --> G["Load ObieAppSettings/explore.json\n-> _S.lineWidth/yDbRange/xMin/xMax"]
    F --> G
    G --> H["_loadBandsFromFolder(bandsHandle) -> _dynamicBandPresets\n(.json with edges or bands, or legacy tab-separated .txt)"]
    H --> I["_loadListsFromFolder(listsHandle) -> _lists\n(.json {name,files,colors}, or legacy LabVIEW <Array><Cluster> XML via _parseLVList)"]
    I --> J["_loadCustomPalettesFromFolder(colorsHandle) -> _customPalettesList\n(.json {name,colors}, or legacy 4-byte-per-color .txt)"]
    J --> K["Read Templates/*.json -> _templates,\npopulate #new-test-menu"]
    K --> L["_scanDir(dir, '') recursively -> _dirFiles [{name,ext,path,handle}]\n(skips ObieAppSettings/; keeps .trf .trv .avc .avr .csv .mat)"]
    L --> M["_countTopDirs() (excludes ObieAppSettings/Test_Samples/Group Averages)\n-> '(N instruments)' label"]
    M --> N["Update folder button + #folder-name-ind; hide #folder-overlay"]
    N --> O["saveDataFolderHandle(dir) — synced to shared cross-tool IndexedDB"]
```

## 4. File loading & parsing dispatch

```mermaid
flowchart TD
    A["Trigger: Browse input, Search 'Load Selected',\nLists 'Load', or drag-drop onto plot"] --> B["file.arrayBuffer() -> Uint8Array"]
    B --> C["_pendingPaths[name] = relative path\n(and _pendingColors[name] if a Lists entry specified a color)"]
    C --> D["window.pyExploreLoadFile(name, bytes)"]
    D --> E["Python _load_frf(name, data)"]
    E --> F["files.load(name, data) dispatches by extension"]
    F --> G[".trf / .trv -> trf_fileio.parse_trf"]
    F --> H[".avc -> avc_fileio.parse_avc -> _av_standard"]
    F --> I[".avr -> avc_fileio.parse_avr -> _av_standard"]
    F --> J[".csv -> tsv_fileio.parse_csv"]
    F --> K[".tsv -> tsv_fileio.parse_tsv\n(dispatch only — not in Browse's accept list or the folder scan)"]
    F --> L[".mat -> mat_fileio.parse_mat_bytes -> _mat_standard"]
    F --> M["unsupported extension -> n_rows=0 + warning"]
    G --> N["standard dict: header, freq, mag, n_rows, warnings, coh (optional)"]
    H --> N
    I --> N
    J --> N
    K --> N
    L --> N
    N --> O{"n_rows == 0?"}
    O -- yes --> P["obieExploreError(name, warning)\n-> alert (unsupported type) or status text (other errors)"]
    O -- no --> Q["is_complex = header.fComplex=='yes' for trf/trv,\nalways True for avc, else False"]
    Q --> R["obieExploreAddDataset(name, freq, mag, coh, isComplex)"]
    R --> S{"Dataset name already loaded?"}
    S -- yes --> T["status: 'Already loaded: name' — skipped"]
    S -- no --> U["_saveUndo(); color from _pendingColors or palette-by-index;\npath from _pendingPaths (defaults to filename)"]
    U --> V["_datasets.push(...); _renderList(); render()"]
```

## 5. Plotting pipeline — `render()`

`render()` is the single redraw entry point — called after any dataset,
axis, smoothing, normalization, band, palette, or coherence-toggle change.

```mermaid
flowchart TD
    A["render() called"] --> B["_updateComplexAvgOption()\ndisables 'Complex average' unless a visible dataset has isComplex"]
    B --> C["Per visible dataset: _smooth(freqs,mags,semitones) -> _applyNorm(freqs,mags)"]
    C --> D{"_S.yLog?"}
    D -- yes --> E["mags -> 10^(m/20) (linear magnitude)"]
    D -- no --> F["mags stay in dB"]
    E --> G["push one Plotly scatter trace per visible dataset"]
    F --> G
    G --> H{"normMode is complex_avg or real_avg?"}
    H -- yes --> I["_computeAvgTrace(): resample every visible dataset onto the\nfirst dataset's freq grid via _linterp, then mean\n(linear-amplitude mean for complex_avg, dB mean for real_avg)"]
    I --> J["push black overlay trace; cache result in _lastAvgTrace\n(consumed by the right-click 'Save to Group Averages' menu)"]
    H -- no --> K["_lastAvgTrace = null"]
    G --> L{"Active band set? (dynamic preset, 'custom', or none)"}
    L -- yes --> M["_computeBands(freqs,mags,bands) per visible dataset\n-> avg_db + power-weighted centroid per band"]
    M --> N["Band shading rects drawn once (if _S.bandShading);\navg-line + centroid-marker traces drawn once per dataset, colored by dataset"]
    N --> O["_renderBandTable(allBandData) — sidebar HTML table"]
    L -- no --> P["_renderBandTable(null)"]
    G --> Q["Compute yRange: fixed _S.yMin/yMax if set,\nelse auto = [maxVisibleY - _S.yDbRange, maxVisibleY + 2]\n(scoped to the visible X range); yLog mode autoscales instead"]
    Q --> R{"_S.showCoh and any visible dataset has cohs?"}
    R -- yes --> S["Coherence traces scaled into the bottom third of yRange;\ncustomdata carries the true gamma^2 (0-1) for hover"]
    R -- no --> T["no coherence traces; #coh-chk disabled if no dataset carries coh"]
    S --> U["Plotly.react('explore-plot', [...FRF, ...bands, ...coh], layout)"]
    T --> U
```

## 6. Search modal — find and load files from the Data Folder

```mermaid
flowchart TD
    A["expSearch() click"] --> B{"_dataDir set?"}
    B -- no --> C["alert: 'Set a Data Folder first'"]
    B -- yes --> D["open #search-modal; _runSearch()"]
    D --> E["Filter _dirFiles by:\nfile-type checkboxes (All / AvR / AvC / TRF-TRV, mutually exclusive with All),\ncomma-separated name pattern (OR match),\nup to 3 keyword fields (OR match)"]
    E --> F["Render matches into #search-results-list;\nre-runs live on every keystroke/checkbox change"]
    F --> G["Click toggles one item; Shift-click range-selects\nfrom the last clicked index"]
    G --> H["expLoadSelected() — 'Load Selected' button"]
    H --> I["Per selected file: handle.getFile(),\nstash _pendingPaths[name]=path, pyExploreLoadFile(name,bytes)"]
    I --> J["-> obieExploreAddDataset (Section 4)"]
```

## 7. Lists and Group Average — saved file sets and average export

| Action | Function(s) | What happens |
|---|---|---|
| Open Lists modal | `expLists` | Renders `_lists` (populated by `_loadListsFromFolder` from `ObieAppSettings/lists/`: JSON `{name,description,files,colors}`, or legacy LabVIEW `<Array><Cluster>` XML parsed by `_parseLVList`) |
| Load a list | `expLoadList(idx)` | Per file path: match `_dirFiles` by exact path, else by basename; skip names already loaded; `pyExploreLoadFile` per match; reports "N loaded, M not found" |
| Save current datasets as a list | `expSaveCurrentList` | Prompts for name/description, writes `{name,description,files:[d.path or d.name,...]}` as JSON under `_listsHandle`, then reloads `_lists` |
| Save Group Average — CSV | `expSaveGroupAverage` -> `format:'csv'` | Requires `_lastAvgTrace` (only set while `normMode` is `complex_avg`/`real_avg`); requests readwrite permission on `_dataDir`, writes `Frequency_Hz,<mode>_Average_dB` rows into `Group Averages/<name>.csv` |
| Save Group Average — AvR | `expSaveGroupAverage` -> `format:'avr'` | `_buildAvFile()` calls `pyExploreWriteAv` -> Python `_write_av_file` -> `avc_fileio.build_avr(freqs, linear_mags, n_averages, AT_MEAN)`; bytes come back via `onExploreAvReady` and are written into `Group Averages/<name>.avr` |
| Right-click "Save to Group Averages…" | `_setupContextMenu` | Only shown on the plot when `normMode` is `complex_avg`/`real_avg` **and** `_lastAvgTrace` exists |

## 8. Color palette subsystem

```mermaid
flowchart TD
    A["expColors() click"] --> B["Seed builder: _cpColors = [..._palette]"]
    B --> C["_renderColorModal(): Built-in (default/warm/cool/contrast)\n+ Saved Custom (_customPalettesList from _colorsHandle,\nor localStorage 'obieExplore_customPalettes' fallback)"]
    C --> D["_renderCustomPaletteBuilder(): editable swatches, 2-12 colors"]
    D --> E{"User action"}
    E -- "Pick built-in" --> F["expPickPalette(name)\n_palette = PALETTES[name]; recolor datasets by index; render()"]
    E -- "Pick saved custom" --> G["expPickCustomPalette(idx)\n_palette = [...p.colors]; recolor; render()"]
    E -- "+ / -" --> H["expCustomPaletteAdd / expCustomPaletteRemove\nmutate _cpColors (bounded 2-12)"]
    E -- "Apply" --> I["expApplyCustomPalette (unsaved)\n_palette = [..._cpColors]; recolor; render()"]
    E -- "Save & Apply" --> J["expSaveCustomPalette\nwrites {name,colors} JSON to _colorsHandle\n(or localStorage list if no Data Folder); reloads list; applies"]
    E -- "✕ delete" --> K["expDeleteCustomPalette(idx)\ncolorsHandle.removeEntry() or splice from localStorage list"]
```

## 9. Preferences — in-page modal + standalone tab

```mermaid
flowchart TD
    A["expPreferences() click"] --> B["_applyPrefsToForm(_loadPrefs())\nmerges 'obieExplore_prefs' localStorage over _PREF_DEFAULTS"]
    B --> C["_enumeratePrefsOutputs()\nlists audiooutput devices for WAV-playback device select"]
    C --> D["open #prefs-modal"]
    D --> E{"User action"}
    E -- "Browse… (WAV)" --> F["expBrowseWav: file picker ->\nstores bytes in _IDB('wavData'), remembers name,\nclears the URL-default override"]
    E -- "Save" --> G["expSavePrefs: reads form ->\nlocalStorage 'obieExplore_prefs' + 'obieExplore_defaultWavUrl';\nupdates _S; _syncControls(); render()"]
    G --> H["_saveExploreJson(): also persists\nlineWidth/yDbRange/xMin/xMax to ObieAppSettings/explore.json\nif a Data Folder is connected"]
    E -- "Reset defaults" --> I["expResetPrefs: clears prefs + WAV keys/IDB entry,\nrestores _PREF_DEFAULTS, render()"]
    E -- "Close" --> J["expClosePrefs"]
    K["Standalone preferences.html tab\n(same 'obieExplore_prefs' keys + IDB store)"] -.->|"user saves there"| L["'storage' event fires in the open Explore tab"]
    L --> M["explore.js storage listener: updates _S,\nrewrites explore.json if a folder is connected,\n_syncControls(); render() — no reload needed"]
```

Note: `preferences.html` duplicates the WAV/plot-defaults form and its own
minimal IndexedDB helper so it can run outside the main tool page, but reads
and writes the exact same `localStorage` keys (`obieExplore_prefs`,
`obieExplore_wavName`, `obieExplore_defaultWavUrl`) and the same `obieExplore`
IDB database/`wavData` key as `explore.js`.

## 10. Other side systems

| System | Key functions | What it does |
|---|---|---|
| **Interpret modal** | `expInterpret`, `expInterpretSetDict`, `_renderInterpretDict`, `expSetHarmonicNote` | Redraws visible datasets on a separate `interpret-plot` with shaded region overlays from `INTERPRET_DICTS` (Radiation / Accelerance / Vibrometer presets: A0, CBR, B1-, B1+, Transition Hill, Bridge Hill, Upper Hill) plus optional dotted note-harmonic lines from `HARMONIC_NOTES` (12 semitones, G3–F#4 fundamentals) |
| **Convolve & Play** | `_playDataset`, `pyExploreConvolve` / `_convolve_explore`, `onExploreConvolveResult` | Per-dataset ▶ button converts the dataset's dB magnitudes to `H = 10^(mag/20)` (amplitude only, no phase), calls Python `convolve_it()` (`Python/processing/convolution.py`) against the cached default WAV, and plays the result through a fresh `AudioContext` |
| **Default WAV** | `pyExploreSetWav` / `_set_default_wav`, `obieExploreWavReady` / `obieExploreWavError` | Decodes a WAV via `scipy.io.wavfile` from IDB-cached bytes or a fetched URL, mono-mixes and peak-normalizes it; used only as the Convolve & Play source |
| **Instrument notes panel** | `_showInstrumentNotes`, `_notesInstrumentCache` | On dataset-row hover, looks up `<instrument>/notes.txt` (first path segment under the Data Folder root — written by Acquire's Notes feature) and shows it read-only in the sidebar; caches per instrument, including confirmed-absent |
| **Coherence overlay & hover readout** | `render()` coherence block, `_setupHover`, `_freqToNote` | `#coh-chk` is enabled only when a loaded dataset carries `d.cohs`; hovering shows `γ² = …` for coherence traces or `Amp = … dB` + nearest musical note for FRF traces |
| **Print** | `expPrintPlot` | `Plotly.toImage()` snapshot opens in a separate blank tab with an editable title/notes area and a Print button — kept isolated from the toolbar/sidebar |
| **Share (CSV export)** | `expShare` | Exports all visible datasets to one CSV over the union of their exact frequency points (no interpolation — a point missing at a given frequency is left blank) |
| **Keyboard shortcuts** | `document` keydown handler | ArrowUp/Down: line width ±0.25px; ArrowLeft/Right: FRF trace opacity ±0.05 (ignored while an input/select/textarea has focus) |
| **Undo** | `_saveUndo`, `expUndo`, `_syncUndoBtn` | Snapshots up to 20 deep-copied `_datasets` states before every destructive op (See All/None, Reduce, Clear All, loading a new dataset) |
| **Sidebar resizer** | `_setupResizer` | Drag-resizable sidebar (80–500px), width persisted to `localStorage['obieExplore_sidebarW']` |
