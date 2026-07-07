'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// modeshape.js — Modal Analysis Tool (view-only, no acquisition)
// Loads TRF data from a run folder, visualises FRFs, animates mode shapes.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Plotly configs ────────────────────────────────────────────────────────────
const PCFG_HOVER = { responsive: true, displayModeBar: 'hover' };
const PCFG_NONE  = { responsive: true, displayModeBar: false };

// ── Colour palette ────────────────────────────────────────────────────────────
const PALETTE = [
  '#e65100','#1565c0','#2e7d32','#6a1b9a','#00838f',
  '#c62828','#0277bd','#558b2f','#f9a825','#ad1457',
  '#4527a0','#00695c','#283593','#d84315','#37474f',
];

// ── State ─────────────────────────────────────────────────────────────────────
let _rootDirHandle  = null;
let _templatesHandle = null;
let _activeTab      = 'frf';

// Run data
let _runName        = '';
let _frfData        = {};   // nodeIdx(0-based) → { freq[], mag[], re[]?, im[]?, coh[]? }
let _complexFRFs    = {};   // nodeIdx string → { freq[], real[], imag[] }
let _trfPending     = 0;
let _trfDone        = 0;
let _selectedNodes  = new Set();  // highlighted in sidebar

// Stencil / geometry
let _stencilName    = '';
let _stencilNodes   = [];   // raw stencil node array
let _geometry       = { nodes: [], edges: [] };
let _stencils       = [];   // [{name, data}]
let _selectedStencil = null;

// Run list
let _runs           = [];   // [{name, trfHandle, path}]
let _selectedRun    = null;

// Mode shape state
let _modeFreqHz    = 1000;
let _modeAmp       = 1.0;
let _deformAxis    = 'z';
let _viewMode      = '3d';   // '3d' = animated surface | '2d' = static contour
let _refFrfVisible = true;
let _sceneCamera   = { eye: { x: 0, y: -1.8, z: 1.4 }, up: { x: 0, y: 0, z: 1 } };
let _sceneUiRev    = 0;   // bumped only on a genuine reset so Plotly keeps the
                          // live camera/dragmode during animation-frame updates
let _userInteracting    = false;  // true while a drag/wheel gesture owns the gl3d camera
let _interactionStarted = null;
let _wheelIdleTimer     = null;
let _animRunning = false;
let _animRafId   = null;
let _animStart   = null;
let _lastFrame   = 0;
const _ANIM_HZ   = 0.4;

// Bicubic spline surface state (precomputed per frequency change)
let _reFine = null;   // Float64Array[][] [ny][nx] — normalised Re on fine grid
let _imFine = null;   // Float64Array[][] [ny][nx] — normalised Im on fine grid
let _xFine  = null;   // Float64Array [nx] — x-coordinates in cm
let _yFine  = null;   // Float64Array [ny] — y-coordinates in cm

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const handle = await loadDataFolderHandle();
  if (handle) {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      document.getElementById('ms-folder-name').textContent = handle.name;
      await _applyDataFolder(handle);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Data folder
// ─────────────────────────────────────────────────────────────────────────────

window.msSetDataFolder = async function() {
  let handle;
  try { handle = await showDirectoryPicker(); }
  catch { return; }
  await saveDataFolderHandle(handle);
  document.getElementById('ms-folder-name').textContent = handle.name;
  await _applyDataFolder(handle);
};

async function _applyDataFolder(dirHandle) {
  _rootDirHandle   = dirHandle;
  _templatesHandle = null;
  _stencils = [];
  _runs = [];

  // Access ObieAppSettings/Templates/ without { create: true } — avoids needing write permission
  try {
    const settingsH = await dirHandle.getDirectoryHandle('ObieAppSettings');
    _templatesHandle = await settingsH.getDirectoryHandle('Templates');
    await _loadStencils();
  } catch { /* ObieAppSettings or Templates not yet created — OK */ }

  await _refreshRunList(false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stencil loading
// ─────────────────────────────────────────────────────────────────────────────

async function _loadStencils() {
  _stencils = [];
  if (!_templatesHandle) return;
  for await (const [name, fh] of _templatesHandle.entries()) {
    if (fh.kind !== 'file' || !name.endsWith('.json')) continue;
    try {
      const file = await fh.getFile();
      const data = JSON.parse(await file.text());
      if (data.type === 'node-stencil' || data.type === 'node-layout') {
        _stencils.push({ name: data.name || name.replace('.json',''), data });
      }
    } catch { /* skip bad JSON */ }
  }
  _stencils.sort((a, b) => a.name.localeCompare(b.name));
}

window.msLoadStencil = async function() {
  await _loadStencils();
  _renderStencilList();
  _showModal('stencil-modal');
};

function _renderStencilList() {
  const el = document.getElementById('ms-stencil-list');
  if (_stencils.length === 0) {
    el.innerHTML = '<div class="tpl-list-empty">No stencils found in Templates/ folder.</div>';
    return;
  }
  el.innerHTML = '';
  _stencils.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'tpl-item' + (s === _selectedStencil ? ' selected' : '');
    const n = s.data?.nodes?.length || '?';
    div.innerHTML = `<span class="tpl-name">${_esc(s.name)}</span><span style="font-size:10px;color:var(--muted)">${n} nodes</span>`;
    div.onclick = () => {
      _selectedStencil = s;
      document.querySelectorAll('#ms-stencil-list .tpl-item').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      _applyStencil(s.data);
      _hideModal('stencil-modal');
    };
    el.appendChild(div);
  });
}

window.msCloseStencilModal = function() { _hideModal('stencil-modal'); };

window.msBrowseStencil = async function() {
  let fh;
  try { [fh] = await showOpenFilePicker({ types: [{ description:'JSON', accept:{'application/json':['.json']} }] }); }
  catch { return; }
  try {
    const file = await fh.getFile();
    const data = JSON.parse(await file.text());
    if (data.type !== 'node-stencil' && data.type !== 'node-layout') {
      alert('This file does not appear to be a node stencil.');
      return;
    }
    _applyStencil(data);
    _hideModal('stencil-modal');
  } catch(e) { alert('Could not read stencil: ' + e.message); }
};

function _applyStencil(data) {
  _stencilName  = data.name || 'Stencil';
  _stencilNodes = data.nodes || [];
  document.getElementById('ms-stencil-ind').textContent = '📐 ' + _stencilName;
  _buildGeometryFromStencil();
  if (Object.keys(_complexFRFs).length > 0) {
    _computeModeSurface(_modeFreqHz);
    _renderModePlot(true, 0);
    _renderRefFRF();
  }
  _setStatus('Stencil "' + _stencilName + '" applied — ' + _stencilNodes.length + ' nodes.');
}

function _buildGeometryFromStencil() {
  if (_stencilNodes.length === 0) { _geometry = { nodes: [], edges: [] }; return; }

  // Nodes: convert mm → cm for display, z=0
  const nodes = _stencilNodes.map((n, i) => ({
    id: i,
    label: n.label || String(i + 1),
    x: (n.xMm || 0) / 10,
    y: (n.yMm || 0) / 10,
    z: 0,
  }));

  // Edges: connect nodes that are adjacent in the grid (same row, consecutive col, or same col, consecutive row)
  const edges = [];
  for (let a = 0; a < _stencilNodes.length; a++) {
    const na = _stencilNodes[a];
    for (let b = a + 1; b < _stencilNodes.length; b++) {
      const nb = _stencilNodes[b];
      const rowAdj = na.row === nb.row && Math.abs(na.col - nb.col) === 1;
      const colAdj = na.col === nb.col && Math.abs(na.row - nb.row) === 1;
      if (rowAdj || colAdj) edges.push([a, b]);
    }
  }

  _geometry = { nodes, edges };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tensor-product bicubic spline interpolation
// Equivalent to scipy.interpolate.RectBivariateSpline — C² continuous,
// no triangle-crease artifacts, runs synchronously in the animation loop.
// ─────────────────────────────────────────────────────────────────────────────

function _fitCubicSpline(x, y) {
  // Natural cubic spline through (x[i], y[i]) — second derivatives = 0 at ends.
  const n = x.length;
  if (n < 2) return null;
  if (n === 2) {
    const s = (y[1] - y[0]) / (x[1] - x[0]);
    return { x, y, b: [s, s], c: [0, 0], d: [0, 0] };
  }
  const h = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) h[i] = x[i + 1] - x[i];

  // Thomas algorithm for tridiagonal second-derivative system
  const l = new Float64Array(n), mu = new Float64Array(n),
        z = new Float64Array(n), c  = new Float64Array(n);
  l[0] = 1;
  for (let i = 1; i < n - 1; i++) {
    const alpha = 3 * ((y[i+1]-y[i])/h[i] - (y[i]-y[i-1])/h[i-1]);
    l[i]  = 2*(x[i+1]-x[i-1]) - h[i-1]*mu[i-1];
    mu[i] = h[i] / l[i];
    z[i]  = (alpha - h[i-1]*z[i-1]) / l[i];
  }
  l[n-1] = 1;
  for (let j = n - 2; j >= 0; j--) c[j] = z[j] - mu[j]*c[j+1];

  const b = new Float64Array(n-1), d = new Float64Array(n-1);
  for (let j = 0; j < n - 1; j++) {
    b[j] = (y[j+1]-y[j])/h[j] - h[j]*(c[j+1]+2*c[j])/3;
    d[j] = (c[j+1]-c[j]) / (3*h[j]);
  }
  return { x: Array.from(x), y: Array.from(y),
           b: Array.from(b), c: Array.from(c), d: Array.from(d) };
}

function _evalCubicSpline(spl, xi) {
  if (!spl) return 0;
  const { x, y, b, c, d } = spl;
  const n = x.length;
  if (xi <= x[0])    { const dx = xi-x[0];     return y[0]+b[0]*dx; }
  if (xi >= x[n-1])  { const j=n-2, dx=xi-x[j]; return y[j]+b[j]*dx+c[j]*dx*dx+d[j]*dx*dx*dx; }
  let lo = 0, hi = n - 2;
  while (lo < hi) { const m=(lo+hi+1)>>1; if(x[m]<=xi) lo=m; else hi=m-1; }
  const dx = xi - x[lo];
  return y[lo] + b[lo]*dx + c[lo]*dx*dx + d[lo]*dx*dx*dx;
}

function _tensorSplineGrid(rowYs, colXs, values, yFine, xFine) {
  // Tensor-product bicubic spline: fit rows→x, then columns→y.
  // values[r][c], returns Z[j][i] on (yFine × xFine).
  const nRows = rowYs.length, ny = yFine.length, nx = xFine.length;

  // Pass 1: for each measurement row, interpolate across columns → fine x
  const mid = [];
  for (let r = 0; r < nRows; r++) {
    const spl = _fitCubicSpline(colXs, values[r]);
    mid.push(xFine.map(xi => _evalCubicSpline(spl, xi)));
  }

  // Pass 2: for each fine-x column, interpolate across rows → fine y
  const Z = Array.from({length: ny}, () => new Float64Array(nx));
  for (let ci = 0; ci < nx; ci++) {
    const spl = _fitCubicSpline(rowYs, mid.map(row => row[ci]));
    for (let ri = 0; ri < ny; ri++) Z[ri][ci] = _evalCubicSpline(spl, yFine[ri]);
  }
  return Z;
}

function _linspace(a, b, n) {
  const arr = new Float64Array(n);
  for (let i = 0; i < n; i++) arr[i] = a + (b-a)*i/(n-1);
  return arr;
}

// Called whenever frequency or stencil/FRF data changes.
// Precomputes Re and Im on the fine display grid so animation is just phasor math.
function _computeModeSurface(freqHz) {
  _reFine = null; _imFine = null; _xFine = null; _yFine = null;
  if (!_stencilNodes.length || !Object.keys(_complexFRFs).length) return;

  const rows = [...new Set(_stencilNodes.map(n => n.row))].sort((a,b)=>a-b);
  const cols = [...new Set(_stencilNodes.map(n => n.col))].sort((a,b)=>a-b);
  if (rows.length < 2 || cols.length < 2) return;

  const rowToY = {}, colToX = {};
  _stencilNodes.forEach(n => { rowToY[n.row] = (n.yMm||0)/10; colToX[n.col] = (n.xMm||0)/10; });
  const rowYs = rows.map(r => rowToY[r]);
  const colXs = cols.map(c => colToX[c]);

  // FRF values at freqHz for each node
  const H = _stencilNodes.map((_, i) => {
    const d = _complexFRFs[String(i)];
    return d ? _interpComplexFRF(d, freqHz) : { re: 0, im: 0 };
  });

  // Build 2D Re/Im grids [row][col]
  const Re2D = rows.map(r => cols.map(c => {
    const ni = _stencilNodes.findIndex(n => n.row===r && n.col===c);
    return ni >= 0 ? H[ni].re : 0;
  }));
  const Im2D = rows.map(r => cols.map(c => {
    const ni = _stencilNodes.findIndex(n => n.row===r && n.col===c);
    return ni >= 0 ? H[ni].im : 0;
  }));

  // Fine grid — aspect-ratio aware (longer axis gets more samples)
  const spanX = colXs[colXs.length-1] - colXs[0];
  const spanY = rowYs[rowYs.length-1] - rowYs[0];
  const aspect = (spanX > 0.01 && spanY > 0.01) ? spanX/spanY : 1;
  const NX = aspect >= 1 ? 90 : Math.max(20, Math.round(90*aspect));
  const NY = aspect >= 1 ? Math.max(20, Math.round(90/aspect)) : 90;

  _xFine = _linspace(colXs[0], colXs[colXs.length-1], NX);
  _yFine = _linspace(rowYs[0], rowYs[rowYs.length-1], NY);

  _reFine = _tensorSplineGrid(rowYs, colXs, Re2D, Array.from(_yFine), Array.from(_xFine));
  _imFine = _tensorSplineGrid(rowYs, colXs, Im2D, Array.from(_yFine), Array.from(_xFine));

  // Normalise: peak magnitude on fine grid → 1  (same as README §4)
  let peak = 1e-12;
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) {
      const m = Math.sqrt(_reFine[j][i]**2 + _imFine[j][i]**2);
      if (m > peak) peak = m;
    }
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) { _reFine[j][i] /= peak; _imFine[j][i] /= peak; }
}

// One animation frame: disp(x,y,θ) = Re·cos(θ) − Im·sin(θ)
function _applyPhasorGrid(phase) {
  const cosT = Math.cos(phase), sinT = Math.sin(phase);
  const ny = _reFine.length, nx = _reFine[0].length;
  return Array.from({length: ny}, (_, j) => {
    const row = new Array(nx);
    for (let i = 0; i < nx; i++)
      row[i] = _modeAmp * (_reFine[j][i]*cosT - _imFine[j][i]*sinT);
    return row;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Run list
// ─────────────────────────────────────────────────────────────────────────────

async function _refreshRunList(showModal = true) {
  if (!_rootDirHandle) {
    _setStatus('Select a Data Folder first.');
    return;
  }
  _runs = [];

  // Scan root for dirs with a TRF/ subfolder (direct runs or instrument/run)
  for await (const [name, fh] of _rootDirHandle.entries()) {
    if (fh.kind !== 'directory') continue;
    // Direct: root/RunName/TRF/
    try {
      const trfH = await fh.getDirectoryHandle('TRF', { create: false });
      _runs.push({ name, trfHandle: trfH, testHandle: fh, path: name });
      continue;
    } catch { /* not here */ }
    // One level deeper: root/Instrument/RunName/TRF/
    try {
      for await (const [rName, rFh] of fh.entries()) {
        if (rFh.kind !== 'directory') continue;
        try {
          const trfH = await rFh.getDirectoryHandle('TRF', { create: false });
          _runs.push({ name: name + '/' + rName, trfHandle: trfH, testHandle: rFh, path: name + '/' + rName });
        } catch { /* no TRF */ }
      }
    } catch { /* not iterable */ }
  }

  _runs.sort((a, b) => a.path.localeCompare(b.path));

  if (showModal) {
    _renderRunList();
    _showModal('run-modal');
  }
}

window.msLoadRun = async function() {
  await _refreshRunList(true);
};

window.msRefreshRunList = async function() {
  await _refreshRunList(true);
};

function _renderRunList() {
  const el = document.getElementById('run-list');
  if (_runs.length === 0) {
    el.innerHTML = '<div class="tpl-list-empty">No run folders with TRF/ subfolder found.</div>';
    return;
  }
  el.innerHTML = '';
  _runs.forEach((run, i) => {
    const div = document.createElement('div');
    div.className = 'tpl-item' + (run === _selectedRun ? ' selected' : '');
    div.innerHTML = `<span class="tpl-name">${_esc(run.name)}</span>`;
    div.onclick = () => {
      _selectedRun = run;
      document.querySelectorAll('#run-list .tpl-item').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      _loadAllTRFs(run);
      _hideModal('run-modal');
    };
    el.appendChild(div);
  });
}

window.msCloseRunModal = function() { _hideModal('run-modal'); };

// ─────────────────────────────────────────────────────────────────────────────
// TRF loading
// ─────────────────────────────────────────────────────────────────────────────

async function _loadAllTRFs(run) {
  _frfData     = {};
  _complexFRFs = {};
  _runName     = run.name;
  _trfPending  = 0;
  _trfDone     = 0;

  document.getElementById('ms-run-ind').textContent = '📂 ' + run.name;
  _setStatus('Scanning TRF/ …');
  document.getElementById('ms-count').textContent = '';

  const files = [];
  for await (const [fname, fh] of run.trfHandle.entries()) {
    if (fh.kind !== 'file') continue;
    const lc = fname.toLowerCase();
    if (!lc.endsWith('.trf') && !lc.endsWith('.trv')) continue;
    // Extract position from _N suffix: prefix_1.trf → pos 0
    const m = fname.match(/_(\d+)\.[^.]+$/);
    if (!m) continue;
    const pos = parseInt(m[1], 10) - 1;  // 0-based
    files.push({ fname, fh, pos });
  }

  if (files.length === 0) {
    _setStatus('No TRF files found in ' + run.name + '/TRF/');
    return;
  }

  // Auto-apply stencil from the run folder: template.json preferred, stencil.json for old runs
  if (run.testHandle) {
    try {
      let stencilData = null;
      try {
        const rfh     = await run.testHandle.getFileHandle('template.json');
        const runData = JSON.parse(await (await rfh.getFile()).text());
        if (runData.stencil && (runData.stencil.nodes || runData.stencil.type === 'node-stencil')) {
          stencilData = runData.stencil;
        }
      } catch (_) {}
      if (!stencilData) {
        const sfh  = await run.testHandle.getFileHandle('stencil.json');
        const data = JSON.parse(await (await sfh.getFile()).text());
        if (data && (data.type === 'node-stencil' || data.type === 'node-layout' || data.nodes)) {
          stencilData = data;
        }
      }
      if (stencilData) _applyStencil(stencilData);
    } catch { /* no stencil available — user can pick one manually */ }
  }

  _trfPending = files.length;
  _setStatus('Loading ' + files.length + ' TRF files…');

  for (const { fname, fh, pos } of files) {
    const file  = await fh.getFile();
    const buf   = await file.arrayBuffer();
    const arr   = new Uint8Array(buf);
    window.pyMSLoadTRF(pos, fname, arr);
  }
}

// Called by Python after parsing each TRF
window.onMSTRFLoaded = function(jsonStr) {
  const r = JSON.parse(jsonStr);
  _trfDone++;

  if (r.error) {
    console.warn('TRF parse error pos', r.pos, r.error);
  } else {
    _frfData[r.pos] = { freq: r.freq, mag: r.mag, re: r.re, im: r.im, coh: r.coh };
    if (r.re && r.im) {
      _complexFRFs[String(r.pos)] = { freq: r.freq, real: r.re, imag: r.im };
    }
  }

  document.getElementById('ms-count').textContent = _trfDone + '/' + _trfPending;

  if (_trfDone >= _trfPending) {
    _onAllLoaded();
  }
};

function _onAllLoaded() {
  const n = Object.keys(_frfData).length;
  _setStatus(n + ' FRF' + (n === 1 ? '' : 's') + ' loaded from "' + _runName + '".');
  _updateNodeList();
  _renderFRFPlot();
  if (_geometry.nodes.length > 0) {
    _computeModeSurface(_modeFreqHz);
    _renderRefFRF();
    _renderModePlot(true, 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Node sidebar (FRF tab)
// ─────────────────────────────────────────────────────────────────────────────

function _updateNodeList() {
  const el = document.getElementById('ms-node-list');
  const indices = Object.keys(_frfData).map(Number).sort((a, b) => a - b);

  if (indices.length === 0) {
    el.innerHTML = '<div class="ms-list-empty">No data loaded</div>';
    return;
  }

  el.innerHTML = '';
  indices.forEach(idx => {
    const d = _frfData[idx];
    const label = _stencilNodes[idx]?.label || String(idx + 1);
    const hasComplex = !!d.re;
    const div = document.createElement('div');
    div.className = 'ms-node-item' + (_selectedNodes.has(idx) ? ' selected' : '');
    div.innerHTML =
      `<span class="ms-node-dot" style="background:${PALETTE[idx % PALETTE.length]}"></span>` +
      `<span class="ms-node-lbl">Node ${label}</span>` +
      `<span style="font-size:9px;color:var(--muted);margin-left:auto">${hasComplex ? 'cplx' : 'mag'}</span>`;
    div.title = 'Node ' + label + (hasComplex ? ' (complex FRF)' : ' (magnitude only)');
    div.onclick = () => {
      if (_selectedNodes.has(idx)) _selectedNodes.delete(idx);
      else _selectedNodes.add(idx);
      _updateNodeList();
      _renderFRFPlot();
    };
    el.appendChild(div);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FRF plot (FRF View tab)
// ─────────────────────────────────────────────────────────────────────────────

function _renderFRFPlot() {
  const el = document.getElementById('ms-frf-plot');
  const indices = Object.keys(_frfData).map(Number).sort((a, b) => a - b);

  if (indices.length === 0) {
    Plotly.purge(el);
    return;
  }

  const traces = indices.map(idx => {
    const d = _frfData[idx];
    const label = _stencilNodes[idx]?.label || String(idx + 1);
    const color = PALETTE[idx % PALETTE.length];
    const highlighted = _selectedNodes.size === 0 || _selectedNodes.has(idx);
    return {
      x: d.freq, y: d.mag,
      type: 'scattergl', mode: 'lines',
      name: 'Node ' + label,
      line: { color, width: highlighted ? 1.2 : 0.5 },
      opacity: highlighted ? 1 : 0.25,
    };
  });

  const layout = {
    paper_bgcolor: 'transparent', plot_bgcolor: '#fcfcfc',
    margin: { l: 52, r: 14, t: 14, b: 44 },
    xaxis: {
      title: { text: 'Frequency (Hz)', font: { size: 11 } },
      type: 'log', gridcolor: '#e8e8e8', zeroline: false,
    },
    yaxis: {
      title: { text: 'Magnitude (dB)', font: { size: 11 } },
      gridcolor: '#e8e8e8', zeroline: false,
    },
    legend: { font: { size: 9 }, bgcolor: 'rgba(255,255,255,0.7)', x: 1.01, xanchor: 'left' },
    hovermode: 'x unified',
  };

  Plotly.react(el, traces, layout, PCFG_HOVER);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ref FRF plot (Mode Shape tab) — click to set frequency
// ─────────────────────────────────────────────────────────────────────────────

function _renderRefFRF() {
  const el = document.getElementById('ms-ref-frf');
  const indices = Object.keys(_frfData).map(Number).sort((a, b) => a - b);
  if (indices.length === 0) { Plotly.purge(el); return; }

  const traces = indices.map(idx => {
    const d = _frfData[idx];
    const color = PALETTE[idx % PALETTE.length];
    return { x: d.freq, y: d.mag, type: 'scattergl', mode: 'lines',
             name: 'Node ' + (_stencilNodes[idx]?.label || String(idx+1)),
             line: { color, width: 0.8 }, showlegend: false };
  });

  // Vertical frequency line
  const yAll = indices.flatMap(i => _frfData[i].mag);
  const yMin = Math.min(...yAll), yMax = Math.max(...yAll);
  traces.push({
    x: [_modeFreqHz, _modeFreqHz], y: [yMin, yMax],
    type: 'scatter', mode: 'lines',
    line: { color: 'rgba(230,81,0,0.8)', width: 1.5, dash: 'dot' },
    hoverinfo: 'none', showlegend: false, name: 'freq',
  });

  const layout = {
    paper_bgcolor: 'transparent', plot_bgcolor: '#fcfcfc',
    margin: { l: 44, r: 8, t: 10, b: 36 },
    xaxis: { type: 'log', gridcolor: '#e8e8e8', zeroline: false, title: { text: 'Hz', font: { size: 9 } } },
    yaxis: { gridcolor: '#e8e8e8', zeroline: false, title: { text: 'dB', font: { size: 9 } } },
    hovermode: false,
  };

  Plotly.react(el, traces, layout, PCFG_NONE);

  el.removeAllListeners?.('plotly_click');
  el.on('plotly_click', ev => {
    if (ev.points?.[0]) {
      const f = Math.round(ev.points[0].x);
      msSyncFreq(f);
    }
  });
}

function _updateRefFRFLine() {
  const el = document.getElementById('ms-ref-frf');
  if (!el || !el.data || el.data.length === 0) return;
  const lastIdx = el.data.length - 1;
  Plotly.restyle(el, { x: [[_modeFreqHz, _modeFreqHz]] }, [lastIdx]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────────

window.msSetTab = function(tab) {
  _activeTab = tab;
  document.querySelectorAll('.ms-tab').forEach(el => {
    el.classList.toggle('active', el.id === 'tab-' + tab);
  });
  document.querySelectorAll('.ms-tab-panel').forEach(el => {
    el.classList.toggle('active', el.id === 'panel-' + tab);
  });
  if (tab === 'mode') {
    _renderRefFRF();
    if (Object.keys(_complexFRFs).length > 0 && _geometry.nodes.length > 0) {
      _renderModePlot(true, 0);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Mode shape controls
// ─────────────────────────────────────────────────────────────────────────────

window.msSyncFreq = function(val) {
  const f = Math.max(1, Math.round(Number(val)));
  _modeFreqHz = f;
  document.getElementById('ms-freq-slider').value = f;
  document.getElementById('ms-freq-num').value    = f;
  _updateRefFRFLine();
  _computeModeSurface(f);
  if (!_animRunning) _renderModePlot(false, 0);
};

window.msSyncAmp = function(val) {
  _modeAmp = Math.max(0.01, Number(val));
  if (!_animRunning) _renderModePlot(false, 0);
};

window.msSyncAxis = function(val) {
  _deformAxis = val;
  if (!_animRunning) _renderModePlot(false, 0);
};

window.msSetViewMode = function(mode) {
  if (_viewMode === mode) return;
  _viewMode = mode;

  // Update toggle button styles
  document.getElementById('ms-view-3d')?.classList.toggle('active', mode === '3d');
  document.getElementById('ms-view-2d')?.classList.toggle('active', mode === '2d');

  // In 2D mode: stop any running animation and disable the animate button
  if (mode === '2d') {
    if (_animRunning) msToggleAnimation();
    const animBtn = document.getElementById('ms-anim-btn');
    if (animBtn) { animBtn.disabled = true; animBtn.title = 'Animation only available in 3D view'; }
  } else {
    const animBtn = document.getElementById('ms-anim-btn');
    if (animBtn) { animBtn.disabled = false; animBtn.title = ''; }
  }

  _renderModePlot(true, 0);
};

// ── 2D static contour plot ────────────────────────────────────────────────────

function _renderContourPlot() {
  const nodes  = _geometry.nodes;
  const plotEl = document.getElementById('ms-mode-plot');
  if (!plotEl || !_reFine || !_xFine || !_yFine) return;

  const Z2D = _applyPhasorGrid(0);   // phase=0 → real part = max-deformation snapshot

  const gx0 = _xFine[0], gx1 = _xFine[_xFine.length - 1];
  const gy0 = _yFine[0], gy1 = _yFine[_yFine.length - 1];

  // Contour step: aim for ~10 labelled bands
  const nBands  = 10;
  const cStep   = (2 * _modeAmp) / nBands;

  const MODE_CS = [
    [0.00, '#1a4d8f'], [0.20, '#4f90c8'], [0.35, '#7fb3d4'],
    [0.50, '#878787'], [0.65, '#d48f68'], [0.80, '#c94e20'], [1.00, '#8b1a00'],
  ];

  const nodeX = nodes.map(n => n.x);
  const nodeY = nodes.map(n => n.y);
  const nodeZ = nodes.map((_, i) => {
    if (!_reFine || !_complexFRFs[String(i)]) return 0;
    const d = _complexFRFs[String(i)];
    const { re, im } = _interpComplexFRF(d, _modeFreqHz);
    const peak = Math.max(1e-12, ...Object.values(_complexFRFs).map(dd => {
      const h = _interpComplexFRF(dd, _modeFreqHz);
      return Math.sqrt(h.re**2 + h.im**2);
    }));
    return _modeAmp * re / peak;
  });

  const traces = [
    {
      type: 'contour',
      x: Array.from(_xFine),
      y: Array.from(_yFine),
      z: Z2D,
      colorscale: MODE_CS,
      zmin: -_modeAmp, zmax: _modeAmp,
      contours: {
        coloring: 'heatmap',
        showlines: true,
        start: -_modeAmp, end: _modeAmp, size: cStep,
      },
      line: { color: 'rgba(0,0,0,0.25)', width: 0.8 },
      showscale: true,
      colorbar: {
        len: 0.75, thickness: 14,
        title: { text: 'norm. disp.', side: 'right', font: { size: 9, color: '#555' } },
        tickfont: { size: 8, color: '#555' },
        tickformat: '.2f',
      },
      hoverinfo: 'none',
      name: 'mode',
    },
    {
      type: 'scatter', mode: 'markers+text',
      x: nodeX, y: nodeY,
      text: nodes.map(n => n.label),
      textposition: 'top center',
      textfont: { size: 9, color: '#222' },
      marker: {
        size: nodes.map((_, i) => _complexFRFs[String(i)] ? 8 : 5),
        color: nodeZ,
        colorscale: MODE_CS, cmin: -_modeAmp, cmax: _modeAmp,
        showscale: false,
        line: { color: '#fff', width: 1.5 },
      },
      hovertemplate: nodes.map((n, i) =>
        `Node ${n.label}  disp=${nodeZ[i].toFixed(3)}<extra></extra>`),
      showlegend: false, name: 'nodes',
    },
  ];

  const spanX = gx1 - gx0, spanY = gy1 - gy0;
  const ratio = spanY > 0 ? spanX / spanY : 1;

  const layout = {
    paper_bgcolor: 'transparent', plot_bgcolor: '#fff',
    margin: { l: 58, r: 20, t: 36, b: 52 },
    title: {
      text: `Mode Shape @ ${Math.round(_modeFreqHz)} Hz  (static contour)`,
      font: { size: 12, color: '#333' }, x: 0.5,
    },
    xaxis: {
      title: { text: 'X (cm)', font: { size: 11, color: '#444' } },
      range: [gx0, gx1], zeroline: false,
      gridcolor: '#e0e0e0', tickfont: { size: 10, color: '#555' },
      scaleanchor: 'y', scaleratio: 1,
    },
    yaxis: {
      title: { text: 'Y (cm)', font: { size: 11, color: '#444' } },
      range: [gy0, gy1], zeroline: false,
      gridcolor: '#e0e0e0', tickfont: { size: 10, color: '#555' },
    },
  };

  Plotly.react(plotEl, traces, layout, PCFG_HOVER);
}

window.msToggleRefFRF = function() {
  _refFrfVisible = !_refFrfVisible;
  const panel = document.querySelector('.ms-ref-frf-wrap');
  const btn   = document.getElementById('ms-frf-panel-btn');
  if (panel) panel.style.display = _refFrfVisible ? '' : 'none';
  if (btn)   btn.textContent     = _refFrfVisible ? '◀ FRF' : '▶ FRF';
  // Let Plotly resize the 3-D plot now that its container changed size
  const modePlot = document.getElementById('ms-mode-plot');
  if (modePlot && modePlot.style.display !== 'none') {
    requestAnimationFrame(() => Plotly.Plots.resize(modePlot));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Animation
// ─────────────────────────────────────────────────────────────────────────────

window.msToggleAnimation = function() {
  if (_animRunning) _stopAnimation(); else _startAnimation();
};

function _startAnimation() {
  _animRunning = true;
  _animStart   = performance.now();
  document.getElementById('ms-anim-btn').textContent = '⏸ Pause';
  // Contour-line recomputation (marching squares over the fine grid) is the
  // priciest part of a per-frame surface replot and adds nothing while the
  // shape is moving — drop it during playback to shrink each frame's JS cost,
  // which shortens the window where an in-flight replot can delay a gesture.
  const plotEl = document.getElementById('ms-mode-plot');
  if (plotEl && plotEl._msBranch === 'surface') {
    Plotly.restyle(plotEl, { 'contours.z.show': false }, [0]);
  }
  _animLoop();
}

function _stopAnimation() {
  _animRunning = false;
  if (_animRafId) { cancelAnimationFrame(_animRafId); _animRafId = null; }
  document.getElementById('ms-anim-btn').textContent = '▶ Animate';
  const plotEl = document.getElementById('ms-mode-plot');
  if (plotEl && plotEl._msBranch === 'surface') {
    Plotly.restyle(plotEl, { 'contours.z.show': true }, [0]);
  }
}

function _animLoop(now) {
  if (!_animRunning) return;
  _animRafId = requestAnimationFrame(_animLoop);
  now = now || performance.now();
  if (now - _lastFrame < 33) return;  // ~30 fps cap
  _lastFrame = now;
  // Give the user's drag/scroll gesture sole ownership of the gl3d camera —
  // pushing data through Plotly while it's mid-gesture is what was corrupting
  // the camera controller (stuck zoom/pan/rotate after the first interaction).
  if (_userInteracting) return;
  _renderModePlot(false, (now - _animStart) / 1000, true);
}

// Pause animation-driven plot updates for the duration of a mouse/trackpad
// gesture on the 3-D scene, then resume without a visible time-jump.
function _wireInteractionGuard(plotEl) {
  if (plotEl._msInteractionWired) return;
  plotEl._msInteractionWired = true;

  const begin = () => {
    if (_userInteracting) return;
    _userInteracting = true;
    _interactionStarted = performance.now();
  };
  const end = () => {
    if (!_userInteracting) return;
    _userInteracting = false;
    if (_animStart != null && _interactionStarted != null) {
      _animStart += (performance.now() - _interactionStarted);
    }
    _interactionStarted = null;
  };

  plotEl.addEventListener('mousedown', begin);
  plotEl.addEventListener('touchstart', begin, { passive: true });
  window.addEventListener('mouseup', end);
  window.addEventListener('touchend', end);

  // Wheel/pinch-zoom and two-finger trackpad pan have no discrete "end" event,
  // so treat a short idle gap after the last wheel event as the gesture ending.
  plotEl.addEventListener('wheel', () => {
    begin();
    clearTimeout(_wheelIdleTimer);
    _wheelIdleTimer = setTimeout(end, 200);
  }, { passive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// View-cube — click a face to snap the camera to that view
// ─────────────────────────────────────────────────────────────────────────────

// Unit view directions — scaled by the CURRENT camera distance at snap time
// (see _snapCameraToView) so switching view angle never also changes zoom.
const _VIEW_DIRS = {
  front:  { dir: { x: 0,  y: -1, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  back:   { dir: { x: 0,  y: 1,  z: 0 }, up: { x: 0, y: 0, z: 1 } },
  right:  { dir: { x: 1,  y: 0,  z: 0 }, up: { x: 0, y: 0, z: 1 } },
  left:   { dir: { x: -1, y: 0,  z: 0 }, up: { x: 0, y: 0, z: 1 } },
  top:    { dir: { x: 0,  y: 0,  z: 1 }, up: { x: 0, y: 1, z: 0 } },
  bottom: { dir: { x: 0,  y: 0,  z: -1}, up: { x: 0, y: 1, z: 0 } },
};

function _currentCameraDistance() {
  const eye = _sceneCamera && _sceneCamera.eye;
  if (!eye) return 2.2;
  const d = Math.sqrt(eye.x**2 + eye.y**2 + eye.z**2);
  return d > 0.05 ? d : 2.2;
}

function _snapCameraToView(viewName) {
  const preset = _VIEW_DIRS[viewName];
  const plotEl = document.getElementById('ms-mode-plot');
  if (!preset || !plotEl || plotEl.style.display === 'none') return;

  // Keep whatever zoom distance the user already had — only the direction
  // changes, so clicking a face never snaps the zoom back to a fixed level.
  const dist   = _currentCameraDistance();
  const camera = {
    eye: { x: preset.dir.x * dist, y: preset.dir.y * dist, z: preset.dir.z * dist },
    up:  preset.up,
  };

  // Treat the snap like any other camera gesture: pause the animation for its
  // duration, then resume without a visible time-jump.
  const wasInteracting = _userInteracting;
  if (!wasInteracting) { _userInteracting = true; _interactionStarted = performance.now(); }

  _sceneCamera = camera;
  _sceneUiRev++;
  Plotly.relayout(plotEl, { 'scene.camera': camera, 'scene.uirevision': _sceneUiRev });

  requestAnimationFrame(() => {
    if (wasInteracting) return;
    _userInteracting = false;
    if (_animStart != null && _interactionStarted != null) {
      _animStart += (performance.now() - _interactionStarted);
    }
    _interactionStarted = null;
  });
}

function _wireViewCube() {
  document.querySelectorAll('#ms-view-cube .mvc-face').forEach(el => {
    el.addEventListener('click', () => _snapCameraToView(el.dataset.view));
  });
}

function _setViewCubeVisible(show) {
  const el = document.getElementById('ms-view-cube');
  if (el) el.style.display = show ? '' : 'none';
}

document.addEventListener('DOMContentLoaded', _wireViewCube);

// Spinning the little cube display only changes what's clickable on it — it
// never touches the real Plotly camera by itself, so it can't disturb an
// ongoing animation or zoom level.
let _mvcYaw = 35, _mvcPitch = -22;
window.msRotateViewCube = function(dir) {
  if (dir === 'left')  _mvcYaw   -= 90;
  if (dir === 'right') _mvcYaw   += 90;
  if (dir === 'up')    _mvcPitch += 90;
  if (dir === 'down')  _mvcPitch -= 90;
  const cubeEl = document.getElementById('mvc-cube');
  if (cubeEl) cubeEl.style.transform = `rotateX(${_mvcPitch}deg) rotateY(${_mvcYaw}deg)`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Complex FRF interpolation
// ─────────────────────────────────────────────────────────────────────────────

function _interpComplexFRF(data, freqHz) {
  const fa = data.freq, re = data.real, im = data.imag;
  if (!fa || fa.length === 0) return { re: 0, im: 0 };
  if (freqHz <= fa[0])             return { re: re[0], im: im[0] };
  if (freqHz >= fa[fa.length - 1]) return { re: re[fa.length-1], im: im[fa.length-1] };
  let lo = 0, hi = fa.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (fa[mid] <= freqHz) lo = mid; else hi = mid; }
  const t = (freqHz - fa[lo]) / (fa[hi] - fa[lo]);
  return { re: re[lo] + t*(re[hi]-re[lo]), im: im[lo] + t*(im[hi]-im[lo]) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3-D mode shape rendering — surface (IDW) or scatter3d lattice fallback
// ─────────────────────────────────────────────────────────────────────────────

function _renderModePlot(resetCamera, t, isAnimFrame) {
  const nodes = _geometry.nodes;
  const edges = _geometry.edges;
  t = t || 0;
  if (resetCamera) _sceneUiRev++;

  const measuredCount = Object.keys(_complexFRFs).length;
  const noDataEl = document.getElementById('ms-no-data-msg');
  const plotEl   = document.getElementById('ms-mode-plot');

  if (measuredCount === 0 || nodes.length === 0) {
    noDataEl.style.display = 'flex';
    plotEl.style.display   = 'none';
    _setViewCubeVisible(false);
    return;
  }
  noDataEl.style.display = 'none';
  plotEl.style.display   = 'block';

  // Dispatch to 2D contour renderer when in static mode
  if (_viewMode === '2d') { _setViewCubeVisible(false); _renderContourPlot(); return; }
  _setViewCubeVisible(true);

  const N = nodes.length;

  // Complex mode shape at selected frequency
  const H = nodes.map((_, i) => {
    const d = _complexFRFs[String(i)];
    return d ? _interpComplexFRF(d, _modeFreqHz) : { re: 0, im: 0 };
  });
  const maxMag = Math.max(1e-12, ...H.map(h => Math.sqrt(h.re**2 + h.im**2)));
  const Hn     = H.map(h => ({ re: h.re / maxMag, im: h.im / maxMag }));

  // Deformation at time t
  const phase = 2 * Math.PI * _ANIM_HZ * t;
  const defs  = Hn.map(h => _modeAmp * (h.re * Math.cos(phase) - h.im * Math.sin(phase)));

  const isNew = !plotEl._msListening;

  if (_reFine && _xFine && _yFine) {
    // ── Bicubic-spline surface (smooth, C² continuous) ────────────────────────
    const phase = 2 * Math.PI * _ANIM_HZ * t;
    const Z2D   = _applyPhasorGrid(phase);

    // Node markers: deformation at each measurement point (node-level normalization)
    const nodeX      = nodes.map(n => n.x);
    const nodeY      = nodes.map(n => n.y);
    const nodeColors = nodes.map((_, i) => _complexFRFs[String(i)] ? defs[i] / _modeAmp : 0);
    const nodeZ      = nodes.map((_, i) => _complexFRFs[String(i)] ? defs[i] : 0);

    // Animation ticks only touch the deforming z/color data via restyle. A full
    // Plotly.react() every ~33 ms pins the main thread and rebuilds the scene's
    // interaction layer, which blocks camera drags, scroll-zoom, and modebar
    // clicks while the animation is playing.
    if (isAnimFrame && !isNew && plotEl._msBranch === 'surface') {
      Plotly.restyle(plotEl, { z: [Z2D, nodeZ], 'marker.color': [undefined, nodeColors] }, [0, 1]);
      return;
    }

    const gx0 = _xFine[0], gx1 = _xFine[_xFine.length-1];
    const gy0 = _yFine[0], gy1 = _yFine[_yFine.length-1];
    const spanX = gx1 - gx0, spanY = gy1 - gy0;
    const zAmp  = Math.max(0.1, _modeAmp * 1.5);

    // Diverging colorscale: blue → steel → gray → salmon → red.
    // Using gray (not white) at the midpoint keeps the nodal line visible
    // against a white page background.
    const MODE_COLORSCALE = [
      [0.00, '#1a4d8f'],
      [0.20, '#4f90c8'],
      [0.35, '#7fb3d4'],
      [0.50, '#878787'],
      [0.65, '#d48f68'],
      [0.80, '#c94e20'],
      [1.00, '#8b1a00'],
    ];

    const traces = [
      {
        type: 'surface',
        x: Array.from(_xFine),
        y: Array.from(_yFine),
        z: Z2D,
        colorscale: MODE_COLORSCALE,
        reversescale: false,
        cmin: -_modeAmp, cmax: _modeAmp,
        opacity: 1.0,
        showscale: true,
        colorbar: {
          len: 0.5, thickness: 12,
          title: { text: 'def.', side: 'right', font: { size: 9, color: '#555' } },
          tickfont: { size: 8, color: '#555' },
        },
        contours: {
          z: {
            show: true,
            usecolormap: false,
            color: 'rgba(0,0,0,0.28)',
            width: 1,
            project: { z: false },
          },
        },
        lighting: { ambient: 0.45, diffuse: 0.75, roughness: 0.45, specular: 0.35 },
        lightposition: { x: 800, y: -400, z: 1200 },
        hoverinfo: 'none',
        showlegend: false,
        name: 'plate',
      },
      {
        type: 'scatter3d', mode: 'markers+text',
        x: nodeX, y: nodeY, z: nodeZ,
        text: nodes.map(n => n.label),
        textposition: 'top center',
        textfont: { size: 8, color: '#333' },
        marker: {
          size: nodes.map((_, i) => _complexFRFs[String(i)] ? 5 : 3),
          color: nodeColors,
          colorscale: MODE_COLORSCALE, cmin: -1, cmax: 1,
          showscale: false,
          line: { color: 'rgba(0,0,0,0.45)', width: 1 },
        },
        hovertemplate: nodes.map((n, i) => {
          const d = _complexFRFs[String(i)];
          return `Node ${n.label}<br>def=${d ? defs[i].toFixed(4) : 'N/A'}<extra></extra>`;
        }),
        showlegend: false, name: 'nodes',
      },
    ];

    const layout = {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { l: 0, r: 0, t: 30, b: 0 },
      title: { text: `Mode Shape @ ${Math.round(_modeFreqHz)} Hz`, font: { size: 12, color: '#333' }, x: 0.5 },
      scene: {
        bgcolor: 'rgba(255,255,255,1)',
        xaxis: { title: 'X (cm)', range: [gx0, gx1], gridcolor: '#ccd', zeroline: false,
                 tickfont: { color: '#666' }, titlefont: { color: '#555' } },
        yaxis: { title: 'Y (cm)', range: [gy0, gy1], gridcolor: '#ccd', zeroline: false,
                 tickfont: { color: '#666' }, titlefont: { color: '#555' } },
        zaxis: { title: 'Deformation', range: [-zAmp, zAmp],
                 gridcolor: '#ccd', zeroline: true, zerolinecolor: '#aaa', zerolinewidth: 1,
                 tickfont: { color: '#666' }, titlefont: { color: '#555' } },
        aspectmode: 'manual',
        aspectratio: {
          x: Math.max(0.3, spanX),
          y: Math.max(0.3, spanY),
          z: Math.max(0.2, Math.min(spanX, spanY) * 0.6),
        },
        camera: resetCamera
          ? (_sceneCamera = { eye: { x: 0, y: -1.8, z: 1.4 }, up: { x: 0, y: 0, z: 1 } })
          : _sceneCamera,
        uirevision: _sceneUiRev,
      },
    };

    Plotly.react(plotEl, traces, layout, PCFG_HOVER);
    plotEl._msBranch = 'surface';
    _wireInteractionGuard(plotEl);

    if (isNew) {
      plotEl._msListening = true;
      plotEl.on('plotly_relayout', ev => {
        const cam = ev['scene.camera'];
        if (cam) _sceneCamera = cam;
      });
    }
    return;
  }

  // ── Fallback: scatter3d lattice (< 3 nodes or degenerate geometry) ──────────
  const xs = nodes.map((n, i) => n.x + (_deformAxis === 'x' ? defs[i] : 0));
  const ys = nodes.map((n, i) => n.y + (_deformAxis === 'y' ? defs[i] : 0));
  const zs = nodes.map((n, i) => n.z + (_deformAxis === 'z' ? defs[i] : 0));
  const gx = nodes.map(n => n.x);
  const gy = nodes.map(n => n.y);
  const gz = nodes.map(n => n.z);

  const ex = [], ey = [], ez = [];
  edges.forEach(([a, b]) => { ex.push(xs[a], xs[b], null); ey.push(ys[a], ys[b], null); ez.push(zs[a], zs[b], null); });
  const gex = [], gey = [], gez = [];
  edges.forEach(([a, b]) => { gex.push(gx[a], gx[b], null); gey.push(gy[a], gy[b], null); gez.push(gz[a], gz[b], null); });

  const numericColors = nodes.map((_, i) => _complexFRFs[String(i)] ? defs[i] : 0);

  if (isAnimFrame && !isNew && plotEl._msBranch === 'scatter3d') {
    Plotly.restyle(plotEl, {
      x: [ex, xs], y: [ey, ys], z: [ez, zs],
      'marker.color': [undefined, numericColors],
    }, [1, 2]);
    return;
  }

  const traces = [
    { type:'scatter3d', mode:'lines', x:gex, y:gey, z:gez,
      line:{ color:'rgba(150,150,150,0.25)', width:3 },
      hoverinfo:'none', showlegend:false, name:'ghost' },
    { type:'scatter3d', mode:'lines', x:ex, y:ey, z:ez,
      line:{ color:'rgba(33,150,243,0.8)', width:4 },
      hoverinfo:'none', showlegend:false, name:'structure' },
    { type:'scatter3d', mode:'markers+text',
      x:xs, y:ys, z:zs,
      text: nodes.map(n => n.label),
      textposition: 'top center',
      textfont: { size: 9 },
      marker: {
        size: nodes.map((_, i) => _complexFRFs[String(i)] ? 8 : 5),
        color: numericColors,
        colorscale: 'RdBu', cmin: -1, cmax: 1,
        showscale: true,
        colorbar: { len: 0.5, thickness: 12, title: { text: 'Norm.', side: 'right', font: { size: 9 } }, tickfont: { size: 8 } },
        line: { color: 'rgba(0,0,0,0.3)', width: 0.5 },
      },
      hovertemplate: nodes.map((n, i) => {
        const d = _complexFRFs[String(i)];
        return `Node ${n.label}<br>def=${d ? defs[i].toFixed(3) : 'N/A'}<extra></extra>`;
      }),
      showlegend: false, name: 'nodes' },
  ];

  const allX = xs.concat(gx), allY = ys.concat(gy), allZ = zs.concat(gz);
  const [mnX, mxX] = [Math.min(...allX), Math.max(...allX)];
  const [mnY, mxY] = [Math.min(...allY), Math.max(...allY)];
  const [mnZ, mxZ] = [Math.min(...allZ), Math.max(...allZ)];
  const pad = (Math.max(mxX-mnX, mxY-mnY, mxZ-mnZ) * 0.3) + 0.01;

  const layout = {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 0, r: 0, t: 30, b: 0 },
    title: { text: `Mode Shape @ ${Math.round(_modeFreqHz)} Hz`, font: { size: 12 }, x: 0.5 },
    scene: {
      bgcolor: 'rgba(245,247,250,0.5)',
      xaxis: { title: 'X (cm)', range: [mnX-pad, mxX+pad], gridcolor: '#ddd', zeroline: false },
      yaxis: { title: 'Y (cm)', range: [mnY-pad, mxY+pad], gridcolor: '#ddd', zeroline: false },
      zaxis: { title: 'Z', range: [mnZ-pad-_modeAmp, mxZ+pad+_modeAmp], gridcolor: '#ddd', zeroline: false },
      aspectmode: 'manual',
      aspectratio: {
        x: Math.max(0.3, mxX-mnX+0.01),
        y: Math.max(0.3, mxY-mnY+0.01),
        z: Math.max(0.3, mxZ-mnZ+0.1+_modeAmp),
      },
      camera: resetCamera ? (_sceneCamera = { eye: { x: 1.5, y: 1.5, z: 1 } }) : _sceneCamera,
      uirevision: _sceneUiRev,
    },
  };

  Plotly.react(plotEl, traces, layout, PCFG_HOVER);
  plotEl._msBranch = 'scatter3d';
  _wireInteractionGuard(plotEl);

  if (isNew) {
    plotEl._msListening = true;
    plotEl.on('plotly_relayout', ev => {
      const cam = ev['scene.camera'];
      if (cam) _sceneCamera = cam;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function _setStatus(msg) {
  const el = document.getElementById('ms-status');
  if (el) el.textContent = msg;
}

function _showModal(id) {
  document.getElementById(id)?.classList.add('active');
}

function _hideModal(id) {
  document.getElementById(id)?.classList.remove('active');
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.msHelp = function() {
  window.open('../../Docs/index.html', '_blank');
};
