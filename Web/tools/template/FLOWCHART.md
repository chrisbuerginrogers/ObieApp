# Stencil Builder — Code Flow

This documents how `template.js` drives the Stencil Builder tool (folder:
`Web/tools/template/`). **There is no Python backend here** — no `main.py`,
no `pyscript.toml`, no PyScript `<script type="py">` tag in `index.html`.
The tool is pure vanilla JS + `<canvas>` 2D rendering. It never imports from
`Python/` or `Web/py/` because it does no signal processing or file-format
parsing — it only reads/writes plain JSON (`type: "node-stencil"`) and reads
the plain-text `OBIE_META` tail that Acquire appends after a TRF's binary
data (see `Python/fileio/trf_fileio.py`), which it parses with a small
byte-search helper (`_findBytes`) rather than a full TRF parser.

The page is really two cooperating documents:
- `index.html` + `template.js` — the editor: sidebar (grid, transform, violin
  reference, selected-node detail), toolbar, and the interactive canvas
  (`#tpl-canvas`) where nodes are laid out and dragged.
- `projection.html` — a separate, minimal full-screen window opened via
  `window.open()` that mirrors the same node layout on a black background
  for an actual video projector, driven entirely by `postMessage`.

## 1. Page load / init

`template.js`'s trailing `(async function _init() {...})()` IIFE runs on
load — there's no PyScript readiness gate to wait for, so setup is
synchronous/immediate other than the two `await`s below.

```mermaid
flowchart TD
    A["Page loads - template.js IIFE _init() runs"] --> B["_resizeCanvas()\nsizes canvas to wrapper, then _renderCanvas()"]
    B --> C["_buildGridNodes()\ndefault 4x6 grid centered at physical origin"]
    C --> D["await loadDataFolderHandle()\nshared IndexedDB handle (obie-settings.js)"]
    D --> E{"Handle found and\nreadwrite permission\nalready granted?"}
    E -- no --> F["Leave _rootDirHandle / _templatesHandle null\nuser must click Data Folder"]
    E -- yes --> G["_rootDirHandle = handle\nopenObieAppSettings(handle) sets _templatesHandle\nfolder name shown in toolbar"]
    F --> H{"URL has a\n?file=... query param?"}
    G --> H
    H -- no --> I["Ready - default grid shown, blank name"]
    H -- yes, and _templatesHandle set --> J["_templatesHandle.getFileHandle(wantedFile)\nparse JSON, _applyTemplate(data)"]
    H -- yes, but _templatesHandle still null --> I
    J --> K["Stencil that Acquire's clicked thumbnail\npointed at is now loaded and rendered"]
```

**The `?file=` auto-load.** This is how Acquire's stencil-thumbnail
click-through works: Acquire opens
`template/index.html?file=<templateFileName>.json`. On init, after the data
folder handle is restored from IndexedDB (so `_templatesHandle` is already
resolved), `_init` reads `new URLSearchParams(location.search).get('file')`
and, if present, fetches that exact file out of `_templatesHandle` and runs
it through the same `_applyTemplate()` used by the normal "Open Stencil"
modal. If the folder handle can't be silently restored (no stored handle,
or permission not already `granted`), the query param is silently ignored —
there is no re-prompt for permission during auto-load, only a
`console.warn` on failure.

## 2. Grid building and node editing

### 2a. Rebuilding the grid

```mermaid
flowchart TD
    A["User edits Rows / Cols / X spacing / Y spacing\nthen clicks Rebuild Grid"] --> B["tplRebuildGrid()\nconfirm() first if nodes already exist"]
    B --> C["_readGrid() pulls the four form fields into _grid"]
    C --> D["_buildGridNodes()\nrows x cols nodes on a rectangular grid,\ncentered at (0,0) mm; id/label = 1..N"]
    D --> E["_selected = null\n_updateNodeDetail(), _updateNodeCount()\n_renderCanvas(), _pushToProjection()"]
```

`_buildGridNodes` centers the grid so node (0,0) sits at
`(-((cols-1)*xSpacing)/2, -((rows-1)*ySpacing)/2)` — i.e. the whole grid is
symmetric about the physical origin regardless of row/col count.

### 2b. Coordinate transform and canvas rendering

`_physToScreen(xMm, yMm)` is the core mapping: physical millimeters to
canvas pixels, using `_transform = { scale, xStretch, yStretch, rotation,
panX, panY }`. `scale` is px/mm; `xStretch`/`yStretch` allow independent
axis scaling (for projector keystone correction); `rotation` is applied
before translating by `panX`/`panY` from canvas center. `_screenToPhys` is
its algebraic inverse, used to convert a drag delta back into mm.

`_renderCanvas()` clears the canvas, draws a faint origin crosshair, then
(optionally, if `_verticalMount` is on) wraps the rest of the drawing in an
**extra** `ctx.translate/rotate(-90deg)/translate` around true canvas
center — this is a purely visual rotation applied at draw time, on top of
whatever `_physToScreen` already computed. It then draws the violin outline
(`_drawViolinOutline`), row/col connector edges between neighboring nodes,
and each node circle (color-coded — see below), always via `_physToScreen`.

**The vertical-mount hit-testing gotcha (documented directly in the code
comments above `_physToScreenMounted`):** mouse events report raw canvas
pixel coordinates, which are unaffected by the `ctx.rotate` used for
drawing. So hit-testing and dragging must apply that same extra -90°
rotation manually, or clicks land on a node's un-rotated (visually
displaced) position. `_physToScreenMounted` / `_screenToPhysMounted` exist
purely to re-apply that rotation for mouse math; `_renderCanvas` uses plain
`_physToScreen` (rotation is done via canvas transform instead), while
`_nodeAt` and the drag handlers use the `...Mounted` variants.

### 2c. Node color coding (drawn by `_renderCanvas`)

| State | Fill | Meaning |
|---|---|---|
| Selected (not watching) | orange `#ff9944` with orange halo | Currently selected for sidebar editing |
| Current node (watching) | yellow `#ffdd00` with yellow halo | Next node Watch Run expects a hit at |
| Done (watching) | dim green-gray `rgba(60,90,60,0.45)` | Watch Run confirmed this position complete |
| Pending (watching, not current/done) | muted blue `rgba(80,140,255,0.50)` | Not yet reached |
| Normal (not watching) | blue `rgba(80,140,255,0.88)` | Default idle appearance |

### 2d. Dragging, keyboard nudge, sidebar fields

```mermaid
flowchart TD
    A["mousedown on canvas"] --> B["_nodeAt(mx,my) via _physToScreenMounted hit-test"]
    B --> C{"Hit a node?"}
    C -- yes --> D["_selected = node.id\n_drag = {nodeId, startMX/MY, startXmm/Ymm}"]
    C -- no --> E["_selected = null, _drag = null"]
    D --> F["_updateNodeDetail() shows Label/X/Y fields"]
    E --> F
    F --> G["_renderCanvas()"]

    H["mousemove (document-level, works outside canvas)"] --> I{"_drag active?"}
    I -- yes --> J["Convert screen delta to phys delta via\n_screenToPhysMounted; set node.xMm/yMm"]
    J --> K["_updateNodeDetail(), _renderCanvas(),\n_pushToProjection()"]
    I -- no --> L["Just update hover cursor (grab / default)"]

    M["mouseup (document-level)"] --> N["_drag = null"]

    O["Arrow key, node selected"] --> P["nudge xMm/yMm by 1mm,\nor 0.1mm with Shift held"]
    P --> K

    Q["Escape key"] --> R["_selected = null, _drag = null, re-render"]

    S["Sidebar Label/X/Y inputs edited"] --> T["tplUpdateNodeLabel /\ntplUpdateNodeCoords"]
    T --> K
    U["'Reset to grid position' button"] --> V["tplResetNodeToGrid\nrecomputes node.xMm/yMm from its\noriginal row/col in the centered grid"]
    V --> K
```

## 3. Save / Load flow

```mermaid
flowchart TD
    A["tplSaveTemplate()"] --> B{"_templatesHandle set?"}
    B -- no --> C["alert: set a Data Folder first"]
    B -- yes --> D["prompt() for a template name\n(defaults to current name or 'Violin Layout')"]
    D --> E["_readGrid() captures any unsaved\nsidebar grid-field edits into _grid"]
    E --> F["Build JSON: {name, type:'node-stencil',\nsettings:{positions}, grid, transform, nodes[]}"]
    F --> G["Write to Templates/<sanitized-name>.json via\n_templatesHandle.getFileHandle(create:true) + createWritable"]
    G --> H["_showSaveMsg(name) - 'Saved!' shown,\nreverts to the template name after 2500ms"]

    I["tplOpenTemplateModal()"] --> J["_refreshFolderTemplates()\nscans every .json in _templatesHandle,\nkeeps ones with type node-stencil or node-layout"]
    J --> K["_renderTemplateList() - one row per\nfound template, node/position count shown"]
    K --> L{"User picks a\nfolder entry, or\nclicks Browse file..."}
    L -- folder entry --> M["tplApplyFolderTemplate(i) -> _applyTemplate(t.data)"]
    L -- Browse file --> N["input[type=file] picker,\nparse JSON, _applyTemplate(data)"]
    M --> O["_applyTemplate: warns if data.type is\nneither node-stencil nor node-layout;\nmerges grid/transform, replaces _nodes,\nsets _currentName, repopulates sidebar forms"]
    N --> O
    O --> P["_updateNodeCount(), _showNameIndicator(),\n_renderCanvas(), _pushToProjection()"]
```

`_applyTemplate` is the single entry point used by all three load paths
(folder-template click, Browse-file picker, and the `?file=` auto-load in
`_init`) — it's tolerant of both the current `node-stencil` shape and an
older `node-layout` type tag, and of files missing `grid`/`transform`
entirely (it merges onto the existing in-memory defaults rather than
requiring every key).

Templates can also be deleted from the modal (`tplDeleteFolderTemplate`,
with a `confirm()` and `_templatesHandle.removeEntry`).

## 4. Watch Run — live projection mode

"Watch Run" has no direct coupling to Acquire's code — it works purely by
polling the shared Data Folder's file layout that Acquire also writes to
(`<instrument>/<run>/TRF/*.trf` and `<instrument>/<run>/template.json`).

### 4a. Selecting a run and starting the watch

```mermaid
flowchart TD
    A["tplOpenWatchModal()"] --> B["tplRefreshRunList() -> _scanRuns()\nwalks every folder under _rootDirHandle\n(skips ObieAppSettings), looking for a TRF/\nsubfolder to identify Acquire run folders"]
    B --> C["_renderRunList() - one row per run,\nshowing current TRF file count"]
    C --> D["User clicks Watch on a run"]
    D --> E["tplStartWatching(i)\nfirst calls tplStopWatching(true) to clear\nany prior watch session"]
    E --> F["Read that run's template.json once\n(cache existing.taps -> _watchTaps,\nnull if missing/invalid)"]
    F --> G["Merge current _nodes/_grid into\ntemplate.json's stencil key\n(spreads existing.stencil first, then\nexisting top-level keys, so settings\nAcquire wrote are preserved)"]
    G --> H["await _pollTRF() immediately,\nthen setInterval(_pollTRF, 1000)"]
    H --> I["_updateWatchUI(true): Watch button hidden,\nSync/Stop buttons shown, watch indicator\nshows run label + 'Set Acquire Positions -> N' hint"]
```

### 4b. The poll loop and done-detection

```mermaid
flowchart TD
    A["_pollTRF() tick"] --> B["List TRF/*.trf files,\nmatch filename regex _(digits).trf\nto get a position number per file"]
    B --> C{"No TRF files yet?"}
    C -- yes --> D["Fresh run - _watchDoneNodes empty,\n_watchCurrentNode = node 0"]
    C -- no --> E{"_watchTaps known\n(valid template.json)?"}
    E -- no --> F["Fallback file-existence heuristic:\nif more files than nodes, mark all done;\notherwise everything before the max\nposition seen is 'done', max is 'current'"]
    E -- yes --> G["For each position with a file:\nskip if already in _watchConfirmedDone;\nelse _readTrfMeta reads the OBIE_META\ntext block appended after the TRF's binary\ndata and compares n_hits to _watchTaps"]
    G --> H["n_hits >= _watchTaps ->\nposition marked done AND cached in\n_watchConfirmedDone (own-file check,\nno one-hit lag waiting on the NEXT file)"]
    H --> I["First not-yet-done position becomes\n_watchCurrentNode; if every seen position\nis done, advance to the next unseen node\nor null if that would exceed node count"]
    D --> J["_renderCanvas() + _pushToProjection()"]
    F --> J
    I --> J
```

`_readTrfMeta` never throws: a missing `OBIE_META` marker (older TRF, or a
file still being written) just returns `{}`, which is treated as "not done
yet" rather than an error.

### 4c. Stopping and syncing

```mermaid
flowchart TD
    A["tplStopWatching()"] --> B["clearInterval, null out watch handles,\n_updateWatchUI(false), re-render"]
    C["tplResetWatch() (the Sync button)"] --> D{"Current TRF folder now empty?\n(Acquire's 'Start Over' created a\nnew run folder)"}
    D -- yes --> E["_scanRuns() again, switch _watchHandle /\n_watchTestHandle to the newest run found"]
    D -- no --> F["Keep watching the same run"]
    E --> G["Reset _watchDoneNodes / _watchCurrentNode\nto node 0, re-render, push, then\nawait _pollTRF() to re-sync from disk"]
    F --> G
```

### 4d. Driving `projection.html`

The projector window is **not** a shared worker or `BroadcastChannel` — it
is a plain popup window (`window.open`) driven by `window.postMessage`.

```mermaid
flowchart TD
    A["tplOpenProjection()"] --> B{"_projWindow already\nopen (not closed)?"}
    B -- yes --> C["focus() it, then _pushToProjection()"]
    B -- no --> D["_projWindow = window.open('./projection.html',\n'tpl-projection', 'menubar=no,toolbar=no,...')"]
    D --> E["_pushToProjection() scheduled at\n700ms AND 1600ms after open\n(window may not have its listener\nattached yet on the first attempt)"]
    C --> F["_pushToProjection()"]
    E --> F
    F --> G["_projWindow.postMessage({type:'tpl-update',\nnodes, transform, currentNode, doneNodes,\nviolinViz, verticalMount}, '*')"]
    G --> H["projection.html's window 'message' listener:\nfilters on e.data.type === 'tpl-update',\ncopies each field into its own local vars"]
    H --> I["render() redraws full-screen on black,\nusing its OWN independent copy of\nphysToScreen / drawViolinOutline logic\n(duplicated, not shared/imported code)"]
```

`_pushToProjection()` is called after essentially every state-changing
action in the editor: node drag, keyboard nudge, transform slider input,
grid rebuild, template load/apply, violin toggle/orientation/opacity
change, vertical-mount toggle, and every `_pollTRF` tick while watching. If
`_projWindow` is null or closed, it's a silent no-op — the editor doesn't
require the projection window to be open.

## 5. Other side systems

| System | Key functions | What it does |
|---|---|---|
| **Violin reference overlay** | `tplToggleViolin`, `tplSetViolinOrientation`, `tplSetViolinOpacity`, `_drawViolinOutline` | Draws `violin-outline.svg` under the nodes at a configurable opacity (5-80%) and orientation (vertical/horizontal), scaled/rotated through the same `_transform`. `projection.html` has its own independent copy of this drawing logic (`drawViolinOutline`), kept in sync only via the `violinViz` field in the `tpl-update` postMessage payload. |
| **Vertical projector mount** | `tplToggleVerticalMount` | Flips `_verticalMount`, which adds a -90 degree canvas-transform rotation in both `_renderCanvas` and `projection.html`'s `render()`, and switches node hit-testing/dragging to the `...Mounted` coordinate helpers (section 2b). Toggles the toolbar button's `accent` class as an on/off indicator. |
| **Node detail sidebar** | `_updateNodeDetail`, `tplUpdateNodeLabel`, `tplUpdateNodeCoords`, `tplResetNodeToGrid` | Shows/hides based on `_selected`; label/X/Y fields write straight back into the selected node object and trigger a re-render + projection push on every keystroke (`oninput`). |
| **Data Folder** | `tplSetDataFolder` | Standard shared-handle pattern: `window.showDirectoryPicker({mode:'readwrite'})`, `saveDataFolderHandle`, `openObieAppSettings` (alerts if `isNew`). Same convention as Explore/Acquire. |
| **Help** | `tplHelp` | Opens `../../Docs/index.html` in a new tab, per the standard toolbar convention. |
| **Canvas resize** | `_resizeCanvas` | Bound to `window.resize`; re-sizes the canvas element to its wrapper's current client size and re-renders — no debouncing. |
