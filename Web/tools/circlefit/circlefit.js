'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// circlefit.js — Circle Fit tool
// SDOF Nyquist circle fitting with residual compensation for accelerometer-based
// hammer-impact FRF data. Loads TRF data the same way Modal Analysis does, lets
// the user define candidate mode bands, and hands off to Modal Analysis's 3D
// mode-shape viewer for any fitted frequency.
// ═══════════════════════════════════════════════════════════════════════════════

const PCFG_HOVER = { responsive: true, displayModeBar: 'hover' };

const PALETTE = [
  '#e65100','#1565c0','#2e7d32','#6a1b9a','#00838f',
  '#c62828','#0277bd','#558b2f','#f9a825','#ad1457',
  '#4527a0','#00695c','#283593','#d84315','#37474f',
];

// ── State ─────────────────────────────────────────────────────────────────────
let _rootDirHandle   = null;
let _templatesHandle = null;

let _runs        = [];
let _selectedRun = null;
let _runName     = '';

let _frfData       = {};   // nodeIdx(0-based) -> {freq, mag, re, im, coh?}
let _selectedNodes = new Set();

let _bands = [];           // [{id, fLo, fHi}]
let _nextBandId = 1;

let _fittedModes  = [];    // from onCFModesFitted
let _selectedModeRow = null;

let _trfPending = 0, _trfDone = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const handle = await loadDataFolderHandle();
  if (handle) {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      document.getElementById('cf-folder-name').textContent = handle.name;
      await _applyDataFolder(handle);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Data folder
// ─────────────────────────────────────────────────────────────────────────────

window.cfSetDataFolder = async function() {
  let handle;
  try { handle = await showDirectoryPicker(); }
  catch { return; }
  await saveDataFolderHandle(handle);
  document.getElementById('cf-folder-name').textContent = handle.name;
  await _applyDataFolder(handle);
};

async function _applyDataFolder(dirHandle) {
  _rootDirHandle   = dirHandle;
  _templatesHandle = null;
  _runs = [];

  try {
    const { templatesHandle, isNew, seedsFailed } = await openObieAppSettings(dirHandle);
    _templatesHandle = templatesHandle;
    if (isNew) {
      const seedNote = seedsFailed
        ? '\n\nNote: some default templates and band presets could not be downloaded — check your internet connection and try reselecting the folder.'
        : '';
      alert('This is a new Data Folder and I moved over the default settings folder.' + seedNote);
    }
  } catch (e) { console.warn('openObieAppSettings failed:', e); }

  await _refreshRunList(false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Run list (mirrors Modal Analysis's Load Run flow)
// ─────────────────────────────────────────────────────────────────────────────

async function _refreshRunList(showModal = true) {
  if (!_rootDirHandle) {
    _setStatus('Select a Data Folder first.');
    return;
  }
  _runs = [];

  for await (const [name, fh] of _rootDirHandle.entries()) {
    if (fh.kind !== 'directory') continue;
    try {
      const trfH = await fh.getDirectoryHandle('TRF', { create: false });
      _runs.push({ name, trfHandle: trfH, testHandle: fh, path: name });
      continue;
    } catch { /* not here */ }
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

window.cfLoadRun = async function() { await _refreshRunList(true); };
window.cfRefreshRunList = async function() { await _refreshRunList(true); };
window.cfCloseRunModal = function() { _hideModal('run-modal'); };

function _renderRunList() {
  const el = document.getElementById('run-list');
  if (_runs.length === 0) {
    el.innerHTML = '<div class="tpl-list-empty">No run folders with TRF/ subfolder found.</div>';
    return;
  }
  el.innerHTML = '';
  _runs.forEach(run => {
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

// ─────────────────────────────────────────────────────────────────────────────
// TRF loading
// ─────────────────────────────────────────────────────────────────────────────

async function _loadAllTRFs(run) {
  _frfData = {};
  _selectedNodes = new Set();
  _bands = [];
  _fittedModes = [];
  _selectedModeRow = null;
  _runName = run.name;
  _trfPending = 0;
  _trfDone = 0;

  document.getElementById('cf-run-ind').textContent = '📂 ' + run.name;
  _setStatus('Scanning TRF/ …');

  const files = [];
  for await (const [fname, fh] of run.trfHandle.entries()) {
    if (fh.kind !== 'file') continue;
    const lc = fname.toLowerCase();
    if (!lc.endsWith('.trf') && !lc.endsWith('.trv')) continue;
    const m = fname.match(/_(\d+)\.[^.]+$/);
    if (!m) continue;
    const pos = parseInt(m[1], 10) - 1;
    files.push({ fname, fh, pos });
  }

  if (files.length === 0) {
    _setStatus('No TRF files found in ' + run.name + '/TRF/');
    return;
  }

  _trfPending = files.length;
  _setStatus('Loading ' + files.length + ' TRF files…');

  for (const { fname, fh, pos } of files) {
    const file = await fh.getFile();
    const buf  = await file.arrayBuffer();
    const arr  = new Uint8Array(buf);
    window.pyCFLoadTRF(pos, fname, arr);
  }
}

window.onCFTRFLoaded = function(jsonStr) {
  const r = JSON.parse(jsonStr);
  _trfDone++;

  if (r.error) {
    console.warn('TRF parse error pos', r.pos, r.error);
  } else {
    _frfData[r.pos] = { freq: r.freq, mag: r.mag, re: r.re, im: r.im, coh: r.coh };
  }

  if (_trfDone >= _trfPending) _onAllLoaded();
};

function _onAllLoaded() {
  const n = Object.keys(_frfData).length;
  _setStatus(n + ' FRF' + (n === 1 ? '' : 's') + ' loaded from "' + _runName + '".');
  _updateNodeList();
  _renderBandChips();
  _renderFRFPlot();
  _renderResultsTable();
  Plotly.purge('cf-nyquist-plot');
}

// ─────────────────────────────────────────────────────────────────────────────
// Node sidebar
// ─────────────────────────────────────────────────────────────────────────────

function _updateNodeList() {
  const el = document.getElementById('cf-node-list');
  const indices = Object.keys(_frfData).map(Number).sort((a, b) => a - b);

  if (indices.length === 0) {
    el.innerHTML = '<div class="ms-list-empty">No data loaded</div>';
    return;
  }

  el.innerHTML = '';
  indices.forEach(idx => {
    const d = _frfData[idx];
    const usable = !!(d.re && d.im);
    const div = document.createElement('div');
    div.className = 'ms-node-item'
      + (_selectedNodes.has(idx) ? ' selected' : '')
      + (usable ? '' : ' disabled');
    div.innerHTML =
      `<span class="ms-node-dot" style="background:${usable ? PALETTE[idx % PALETTE.length] : '#ccc'}"></span>` +
      `<span class="ms-node-lbl">Node ${idx + 1}</span>` +
      `<span style="font-size:9px;color:var(--muted);margin-left:auto">${usable ? 'cplx' : 'no cplx'}</span>`;
    div.title = usable
      ? 'Node ' + (idx + 1) + ' — click to include/exclude from the reference FRF'
      : 'Node ' + (idx + 1) + ' has no complex (re/im) FRF data — not usable for circle fitting';
    if (usable) {
      div.onclick = () => {
        if (_selectedNodes.has(idx)) _selectedNodes.delete(idx);
        else _selectedNodes.add(idx);
        _updateNodeList();
        _renderFRFPlot();
      };
    }
    el.appendChild(div);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Complex-valued multi-node averaging (genuinely new — nothing like this
// exists elsewhere in the repo; Modal Analysis's average is magnitude-only
// and discards phase, which circle fitting can't work with)
// ─────────────────────────────────────────────────────────────────────────────

function _computeComplexAverageFRF(idxList) {
  const usable = idxList.filter(i => _frfData[i] && _frfData[i].re && _frfData[i].im);
  if (!usable.length) return null;
  const ref = _frfData[usable[0]];
  const n = ref.freq.length;
  const sumRe = new Float64Array(n);
  const sumIm = new Float64Array(n);
  let count = 0;
  for (const idx of usable) {
    const d = _frfData[idx];
    if (d.re.length !== n || d.im.length !== n) {
      console.warn('_computeComplexAverageFRF: skipping node', idx, '— frequency axis mismatch');
      continue;
    }
    for (let i = 0; i < n; i++) { sumRe[i] += d.re[i]; sumIm[i] += d.im[i]; }
    count++;
  }
  if (count === 0) return null;
  return {
    freq: ref.freq,
    re: Array.from(sumRe, s => s / count),
    im: Array.from(sumIm, s => s / count),
  };
}

// Deliberately returns null when nothing is selected, rather than silently
// falling back to a complex average of every node — averaging arbitrary
// nodes' complex FRFs can partially cancel where they're in opposite phase
// (normal for real mode shapes), so this must be an explicit choice, not a
// hidden default. See _renderFRFPlot: with no selection, every node's own
// (uncancelled, single-measurement-real) magnitude is shown individually so
// there's always a true picture to pick a band/node from.
function _referenceFRF() {
  if (_selectedNodes.size === 0) return null;
  const idxList = [...Object.keys(_frfData).map(Number)]
    .filter(i => _selectedNodes.has(i))
    .sort((a, b) => a - b);
  return _computeComplexAverageFRF(idxList);
}

// ─────────────────────────────────────────────────────────────────────────────
// Band management
// ─────────────────────────────────────────────────────────────────────────────

window.cfAddBand = function() {
  const min = parseFloat(document.getElementById('cf-band-min').value);
  const max = parseFloat(document.getElementById('cf-band-max').value);
  if (!isFinite(min) || !isFinite(max) || min <= 0 || max <= min) {
    _setStatus('⚠️ Enter a valid Min/Max Hz band (min > 0, max > min).');
    return;
  }
  _bands.push({ id: _nextBandId++, fLo: min, fHi: max });
  _renderBandChips();
  _renderFRFPlot();
};

function _removeBand(id) {
  _bands = _bands.filter(b => b.id !== id);
  _renderBandChips();
  _renderFRFPlot();
}

function _renderBandChips() {
  const el = document.getElementById('cf-band-chips');
  el.innerHTML = '';
  _bands.forEach(b => {
    const chip = document.createElement('span');
    chip.className = 'cf-band-chip';
    chip.innerHTML = `${Math.round(b.fLo)}–${Math.round(b.fHi)} Hz <button title="Remove band">✕</button>`;
    chip.querySelector('button').onclick = () => _removeBand(b.id);
    el.appendChild(chip);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FRF plot (magnitude vs log frequency, with shaded band regions)
// ─────────────────────────────────────────────────────────────────────────────

function _renderFRFPlot() {
  const el = document.getElementById('cf-frf-plot');
  const indices = Object.keys(_frfData).map(Number).sort((a, b) => a - b);
  if (!indices.length) { Plotly.purge(el); return; }

  const magOf = (re, im, i) => 20 * Math.log10(Math.max(1e-12, Math.hypot(re[i], im[i])));
  let traces;

  if (_selectedNodes.size === 0) {
    // Nothing selected yet: show every usable node's own real, single-
    // measurement magnitude trace (never cancelled, since it's not an
    // average of anything) — this is the view to identify peaks and pick a
    // node/band from, mirroring Modal Analysis's default per-node view.
    traces = indices
      .filter(idx => _frfData[idx].re && _frfData[idx].im)
      .map(idx => {
        const d = _frfData[idx];
        return {
          x: d.freq, y: d.freq.map((_, i) => magOf(d.re, d.im, i)),
          type: 'scattergl', mode: 'lines',
          name: 'Node ' + (idx + 1),
          line: { color: PALETTE[idx % PALETTE.length], width: 1 },
          hovertemplate: 'Node ' + (idx + 1) + '<br>%{x:.1f} Hz, %{y:.1f} dB<extra></extra>',
        };
      });
  } else {
    // A selection has been made: gray out the rest for context, and draw the
    // complex-averaged reference FRF (what will actually be fit) on top,
    // bold, so it's unmistakable which curve Fit Modes will use.
    traces = indices
      .filter(idx => !_selectedNodes.has(idx) && _frfData[idx].re && _frfData[idx].im)
      .map(idx => {
        const d = _frfData[idx];
        return {
          x: d.freq, y: d.freq.map((_, i) => magOf(d.re, d.im, i)),
          type: 'scattergl', mode: 'lines',
          name: 'Node ' + (idx + 1),
          line: { color: '#ccc', width: 0.6 }, opacity: 0.5, hoverinfo: 'skip',
        };
      });
    const ref = _referenceFRF();
    if (ref) {
      traces.push({
        x: ref.freq, y: ref.freq.map((_, i) => magOf(ref.re, ref.im, i)),
        type: 'scattergl', mode: 'lines',
        name: `Reference FRF (${_selectedNodes.size} node${_selectedNodes.size === 1 ? '' : 's'})`,
        line: { color: '#1565c0', width: 1.8 },
        hovertemplate: '%{x:.1f} Hz, %{y:.1f} dB<extra></extra>',
      });
    }
  }

  const shapes = _bands.map(b => ({
    type: 'rect', xref: 'x', yref: 'paper',
    x0: b.fLo, x1: b.fHi, y0: 0, y1: 1,
    fillcolor: 'rgba(230,81,0,0.10)', line: { width: 1, color: 'rgba(230,81,0,0.4)' },
  }));

  const layout = {
    paper_bgcolor: 'transparent', plot_bgcolor: '#fcfcfc',
    margin: { l: 52, r: 14, t: 14, b: 40 },
    xaxis: { title: { text: 'Frequency (Hz)', font: { size: 11 } }, type: 'log', gridcolor: '#e8e8e8', zeroline: false },
    yaxis: { title: { text: 'Magnitude (dB)', font: { size: 11 } }, gridcolor: '#e8e8e8', zeroline: false },
    hovermode: 'closest',
    shapes,
    showlegend: false,
  };

  Plotly.react(el, traces, layout, PCFG_HOVER);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fit Modes
// ─────────────────────────────────────────────────────────────────────────────

window.cfFitModes = function() {
  if (!_bands.length) { _setStatus('⚠️ Add at least one candidate mode band first.'); return; }
  if (_selectedNodes.size === 0) {
    _setStatus('⚠️ Select one or more nodes in the sidebar first — that builds the reference FRF Fit Modes will use.');
    return;
  }
  const ref = _referenceFRF();
  if (!ref) { _setStatus('⚠️ No usable (complex) FRF data for the selected node(s).'); return; }

  _setStatus('Fitting ' + _bands.length + ' mode' + (_bands.length === 1 ? '' : 's') + '…');
  const bandsPayload = _bands.map(b => ({ f_lo: b.fLo, f_hi: b.fHi }));
  window.pyCFFitModes(ref.freq, ref.re, ref.im, JSON.stringify(bandsPayload), 3);
};

window.onCFModesFitted = function(jsonStr) {
  const r = JSON.parse(jsonStr);
  if (r.error) {
    _setStatus('⚠️ Fit failed: ' + r.error);
    return;
  }
  _fittedModes = r.modes.map(m => {
    if (m.A_r) m.A_r = { real: m.A_r.re, imag: m.A_r.im };
    return m;
  });
  _selectedModeRow = _fittedModes.findIndex(m => m.valid);
  if (_selectedModeRow < 0) _selectedModeRow = null;
  const nValid = _fittedModes.filter(m => m.valid).length;
  _setStatus(`Fit ${nValid}/${_fittedModes.length} mode(s), ${r.n_passes_run} pass(es)${r.converged ? ' (converged)' : ''}.`);
  _renderResultsTable();
  _renderNyquistPlot();
};

// ─────────────────────────────────────────────────────────────────────────────
// Results table
// ─────────────────────────────────────────────────────────────────────────────

function _renderResultsTable() {
  const body = document.getElementById('cf-results-body');
  if (!_fittedModes.length) {
    body.innerHTML = '<tr><td colspan="7" class="cf-results-empty">No modes fitted yet — add one or more bands above and click Fit Modes.</td></tr>';
    return;
  }
  body.innerHTML = '';
  _fittedModes.forEach((m, i) => {
    const tr = document.createElement('tr');
    if (i === _selectedModeRow) tr.style.background = '#fdf6ed';
    if (!m.valid) {
      tr.innerHTML = `<td>${i + 1}</td><td colspan="5" class="cf-results-empty">Invalid — ${_esc(m.reason || 'unknown')}</td><td></td>`;
      body.appendChild(tr);
      return;
    }
    const q = m.quality || {};
    const qualityGood = (q.resid_rms_frac ?? 1) < 0.10 && !q.at_edge;
    const qualityTxt = `${((q.resid_rms_frac ?? 0) * 100).toFixed(1)}%${q.at_edge ? ' (widen band)' : ''}`;
    const magA = Math.hypot(m.A_r.real, m.A_r.imag);
    tr.innerHTML =
      `<td>${i + 1}</td>` +
      `<td>${m.freq_hz.toFixed(2)}</td>` +
      `<td>${m.eta_r.toFixed(4)}</td>` +
      `<td>${(1 / m.eta_r).toFixed(1)}</td>` +
      `<td>${magA.toExponential(2)}</td>` +
      `<td class="${qualityGood ? 'cf-quality-good' : 'cf-quality-bad'}">${qualityTxt}</td>` +
      `<td><button class="act-btn" data-idx="${i}">View in Modal Analysis</button></td>`;
    tr.onclick = e => {
      if (e.target.tagName === 'BUTTON') return;
      _selectedModeRow = i;
      _renderResultsTable();
      _renderNyquistPlot();
    };
    tr.querySelector('button').onclick = () => _viewInModalAnalysis(m);
    body.appendChild(tr);
  });
}

function _viewInModalAnalysis(mode) {
  if (!_selectedRun) return;
  const url = '../modeshape/index.html?run=' + encodeURIComponent(_selectedRun.path)
            + '&freq=' + Math.round(mode.freq_hz);
  window.open(url, '_blank');
}

// ─────────────────────────────────────────────────────────────────────────────
// Nyquist plot
// ─────────────────────────────────────────────────────────────────────────────

function _renderNyquistPlot() {
  const el = document.getElementById('cf-nyquist-plot');
  const mode = _selectedModeRow != null ? _fittedModes[_selectedModeRow] : null;
  if (!mode || !mode.valid || !mode.fit_re) { Plotly.purge(el); return; }

  const circle = mode.circle;
  const nCirc = 128;
  const circleX = [], circleY = [];
  for (let i = 0; i <= nCirc; i++) {
    const a = (i / nCirc) * 2 * Math.PI;
    circleX.push(circle.x0 + circle.r * Math.cos(a));
    circleY.push(circle.y0 + circle.r * Math.sin(a));
  }

  // Locate the resonance point among the fit data by nearest frequency.
  let resIdx = 0, best = Infinity;
  for (let i = 0; i < mode.fit_freq_hz.length; i++) {
    const d = Math.abs(mode.fit_freq_hz[i] - mode.freq_hz);
    if (d < best) { best = d; resIdx = i; }
  }

  const traces = [
    {
      x: mode.fit_re, y: mode.fit_im,
      type: 'scattergl', mode: 'markers',
      name: 'Data (residual-subtracted)',
      marker: { color: '#1565c0', size: 5 },
      hovertemplate: '%{text} Hz<extra></extra>',
      text: mode.fit_freq_hz.map(f => f.toFixed(1)),
    },
    {
      x: circleX, y: circleY,
      type: 'scatter', mode: 'lines',
      name: 'Fitted circle',
      line: { color: '#c62828', width: 1.5, dash: 'dot' },
      hoverinfo: 'skip',
    },
    {
      x: [mode.fit_re[resIdx]], y: [mode.fit_im[resIdx]],
      type: 'scatter', mode: 'markers',
      name: 'Resonance',
      marker: { color: '#2e7d32', size: 10, symbol: 'star' },
      hovertemplate: `f_r = ${mode.freq_hz.toFixed(2)} Hz<extra></extra>`,
    },
  ];

  const layout = {
    paper_bgcolor: 'transparent', plot_bgcolor: '#fcfcfc',
    margin: { l: 52, r: 14, t: 14, b: 40 },
    xaxis: { title: { text: 'Re', font: { size: 11 } }, gridcolor: '#e8e8e8', zeroline: true, scaleanchor: 'y', scaleratio: 1 },
    yaxis: { title: { text: 'Im', font: { size: 11 } }, gridcolor: '#e8e8e8', zeroline: true },
    hovermode: 'closest',
    showlegend: false,
  };

  Plotly.react(el, traces, layout, PCFG_HOVER);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function _setStatus(msg) {
  const el = document.getElementById('cf-status');
  if (el) el.textContent = msg;
}

function _showModal(id) { document.getElementById(id)?.classList.add('active'); }
function _hideModal(id) { document.getElementById(id)?.classList.remove('active'); }

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.cfHelp = function() {
  window.open('../../Docs/index.html', '_blank');
};
