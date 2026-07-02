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
let _refFrfVisible = true;
let _sceneCamera   = { eye: { x: 1.5, y: 1.5, z: 1 } };  // preserved across frames
let _animRunning = false;
let _animRafId   = null;
let _animStart   = null;
let _lastFrame   = 0;
const _ANIM_HZ   = 0.4;

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

  // Auto-apply stencil.json from the run folder if present
  if (run.testHandle) {
    try {
      const sfh  = await run.testHandle.getFileHandle('stencil.json');
      const data = JSON.parse(await (await sfh.getFile()).text());
      if (data && (data.type === 'node-stencil' || data.type === 'node-layout' || data.nodes)) {
        _applyStencil(data);
      }
    } catch { /* no stencil.json — user can pick one manually */ }
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
  _animLoop();
}

function _stopAnimation() {
  _animRunning = false;
  if (_animRafId) { cancelAnimationFrame(_animRafId); _animRafId = null; }
  document.getElementById('ms-anim-btn').textContent = '▶ Animate';
}

function _animLoop(now) {
  if (!_animRunning) return;
  _animRafId = requestAnimationFrame(_animLoop);
  now = now || performance.now();
  if (now - _lastFrame < 33) return;  // ~30 fps cap
  _lastFrame = now;
  _renderModePlot(false, (now - _animStart) / 1000);
}

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
// 3-D mode shape rendering
// ─────────────────────────────────────────────────────────────────────────────

function _renderModePlot(resetCamera, t) {
  const nodes = _geometry.nodes;
  const edges = _geometry.edges;
  t = t || 0;

  const measuredCount = Object.keys(_complexFRFs).length;
  const noDataEl = document.getElementById('ms-no-data-msg');
  const plotEl   = document.getElementById('ms-mode-plot');

  if (measuredCount === 0 || nodes.length === 0) {
    noDataEl.style.display = 'flex';
    plotEl.style.display   = 'none';
    return;
  }
  noDataEl.style.display = 'none';
  plotEl.style.display   = 'block';

  const N = nodes.length;

  // Compute complex mode shape at selected frequency for each node
  const H = nodes.map((_, i) => {
    const d = _complexFRFs[String(i)];
    return d ? _interpComplexFRF(d, _modeFreqHz) : { re: 0, im: 0 };
  });

  // Normalize by max magnitude
  const maxMag = Math.max(1e-12, ...H.map(h => Math.sqrt(h.re**2 + h.im**2)));
  const Hn = H.map(h => ({ re: h.re / maxMag, im: h.im / maxMag }));

  // Deformation at time t
  const phase = 2 * Math.PI * _ANIM_HZ * t;
  const defs = Hn.map(h => _modeAmp * (h.re * Math.cos(phase) - h.im * Math.sin(phase)));

  // Deformed node positions
  const xs = nodes.map((n, i) => n.x + (_deformAxis === 'x' ? defs[i] : 0));
  const ys = nodes.map((n, i) => n.y + (_deformAxis === 'y' ? defs[i] : 0));
  const zs = nodes.map((n, i) => n.z + (_deformAxis === 'z' ? defs[i] : 0));

  // Ghost (undeformed)
  const gx = nodes.map(n => n.x);
  const gy = nodes.map(n => n.y);
  const gz = nodes.map(n => n.z);

  // Edge line arrays
  const ex = [], ey = [], ez = [];
  edges.forEach(([a, b]) => { ex.push(xs[a], xs[b], null); ey.push(ys[a], ys[b], null); ez.push(zs[a], zs[b], null); });
  const gex = [], gey = [], gez = [];
  edges.forEach(([a, b]) => { gex.push(gx[a], gx[b], null); gey.push(gy[a], gy[b], null); gez.push(gz[a], gz[b], null); });

  // Node colours by deformation
  const numericColors = nodes.map((_, i) => _complexFRFs[String(i)] ? defs[i] : 0);

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
    },
  };

  const isNew = !plotEl._msListening;
  Plotly.react(plotEl, traces, layout, PCFG_HOVER);

  // Capture camera after user pans/rotates so we can feed it back every frame.
  // Only attach once — plotly_relayout fires on every interaction.
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
