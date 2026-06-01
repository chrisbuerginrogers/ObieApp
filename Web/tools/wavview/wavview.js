/**
 * wavview.js — WAV Viewer tool: folder scanning, file selection, Plotly rendering.
 * All DSP (WAV parsing, hit detection, FRF) lives in main.py / frf.py.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _rootDir    = null;
let _wavFiles   = [];    // all WAV files found — [{name, path, handle}]
let _visFiles   = [];    // currently visible subset after instrument filter
let _activeIdx  = -1;   // index into _visFiles
let _pyReady    = false;
let _pendingIdx = -1;   // file queued before PyScript was ready
let _instruments = [];  // top-level directory names (instrument folders)

let _S = {
  xLog: true, xMin: 100, xMax: 12000,
  yDbRange: 38, yMin: null, yMax: null,
};

const PCFG = { responsive: true };

// ── Prefs ─────────────────────────────────────────────────────────────────────
function _loadPrefs() {
  const defaults = {
    threshold: 0.05, pre_trig_s: 0.01, post_trig_s: 0.30, swap_channels: false,
  };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('obieWavView_prefs') || '{}') }; }
  catch (_) { return defaults; }
}
function _savePrefs(p) { localStorage.setItem('obieWavView_prefs', JSON.stringify(p)); }

// ── Status ────────────────────────────────────────────────────────────────────
function _setStatus(msg) {
  const el = document.getElementById('wav-status');
  if (el) el.textContent = msg;
}

// ── Folder management ─────────────────────────────────────────────────────────
window.wavSetDataFolder = async function() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    await saveDataFolderHandle(handle);
    localStorage.setItem('obieDataFolderName', handle.name);
    await _applyFolder(handle);
  } catch (e) {
    if (e.name !== 'AbortError') alert('Could not open folder: ' + e.message);
  }
};

async function _applyFolder(handle) {
  _rootDir = handle;
  document.getElementById('folder-name-ind').textContent = handle.name;
  _setStatus('Scanning for WAV files…');
  _wavFiles   = [];
  _activeIdx  = -1;
  await _scanFolder(handle, '');
  _wavFiles.sort((a, b) => (a.path + a.name).localeCompare(b.path + b.name));

  // Collect unique top-level directories as instrument names
  const seen = new Set();
  _wavFiles.forEach(f => { const top = f.path.split('/')[0]; if (top) seen.add(top); });
  _instruments = [...seen].sort();
  _populateInstrumentSel();
  _applyInstrumentFilter();
}

async function _scanFolder(dir, path) {
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        await _scanFolder(handle, path + name + '/');
      } else if (name.toLowerCase().endsWith('.wav')) {
        _wavFiles.push({ name, path, handle });
      }
    }
  } catch (_) {}
}

// ── Instrument dropdown ───────────────────────────────────────────────────────
function _populateInstrumentSel() {
  const sel = document.getElementById('instrument-sel');
  if (!sel) return;
  sel.innerHTML = '<option value="">All</option>'
    + _instruments.map(d => `<option value="${d}">${d}</option>`).join('');
}

function _applyInstrumentFilter() {
  const sel    = document.getElementById('instrument-sel');
  const filter = sel?.value || '';
  _visFiles  = filter
    ? _wavFiles.filter(f => f.path === filter + '/' || f.path.startsWith(filter + '/'))
    : _wavFiles.slice();
  _activeIdx = -1;
  _renderFileList();
  if (_visFiles.length) {
    _setStatus(`${_visFiles.length} WAV file${_visFiles.length !== 1 ? 's' : ''} — click one to view`);
  } else {
    _setStatus(_wavFiles.length ? 'No WAV files for this instrument' : 'No WAV files found in this folder');
  }
}

window.wavFilterInstrument = function(val) { _applyInstrumentFilter(); };

// ── File list ─────────────────────────────────────────────────────────────────
function _renderFileList() {
  const ul = document.getElementById('wav-file-list');
  if (!ul) return;
  if (!_visFiles.length) {
    ul.innerHTML = '<div class="wav-no-files">No WAV files found</div>';
    return;
  }
  ul.innerHTML = _visFiles.map((f, i) => {
    const active   = i === _activeIdx ? ' active' : '';
    const pathHtml = f.path ? `<div class="wav-file-path">${f.path}</div>` : '';
    return `<div class="wav-file-item${active}" title="${f.path}${f.name}"
                 onclick="wavSelectFile(${i})">${f.name}</div>${pathHtml}`;
  }).join('');

  if (_activeIdx >= 0) {
    ul.querySelectorAll('.wav-file-item')[_activeIdx]?.scrollIntoView({ block: 'nearest' });
  }
}

window.wavSelectFile = async function(idx) {
  if (idx < 0 || idx >= _visFiles.length) return;
  _activeIdx = idx;
  _renderFileList();

  if (!_pyReady) {
    _pendingIdx = idx;
    _setStatus('PyScript loading — will open file when ready…');
    return;
  }

  const item = _visFiles[idx];
  _setStatus(`Loading ${item.name}…`);
  try {
    const file = await item.handle.getFile();
    const buf  = await file.arrayBuffer();
    if (window.pyWavProcess) {
      window.pyWavProcess(new Uint8Array(buf), item.path + item.name);
    }
  } catch (e) {
    _setStatus(`Error reading ${item.name}: ${e.message}`);
  }
};

// ── PyScript ready callback ───────────────────────────────────────────────────
window.onPyReady = function() {
  _pyReady = true;
  const p = _loadPrefs();
  if (window.pyWavApplySettings) {
    window.pyWavApplySettings(p.threshold, p.pre_trig_s, p.post_trig_s, p.swap_channels);
  }
  if (_pendingIdx >= 0) {
    const idx = _pendingIdx;
    _pendingIdx = -1;
    wavSelectFile(idx);
  }
};

// ── Python result callbacks ───────────────────────────────────────────────────
window.onWavLoaded = function(t_js, ham_js, mic_js, trigs_js,
                               freqs_js, Hdb_js, coh_js, nHits, sr, fname, fmtLabel) {
  const t     = Array.from(t_js);
  const ham   = Array.from(ham_js);
  const mic   = Array.from(mic_js);
  const trigs = trigs_js ? Array.from(trigs_js) : [];

  const fname_short = String(fname).split('/').pop().split('\\').pop();
  const hitWord = nHits !== 1 ? 'hits' : 'hit';
  const fmt = fmtLabel ? ` · ${fmtLabel}` : '';
  _setStatus(`${fname_short} · ${(sr/1000).toFixed(1)} kHz${fmt} · ${nHits} ${hitWord} detected`);

  const gridColor = '#c0c4cc';

  // Trigger markers — vertical dashed purple lines on time plots
  const trigShapes = trigs.map(t0 => ({
    type: 'line', x0: t0, x1: t0, yref: 'paper', y0: 0, y1: 1,
    xref: 'x', line: { color: '#7c2bc8', width: 1, dash: 'dot' },
  }));

  // Threshold line on hammer plot
  const p = _loadPrefs();
  const thrShapes = [
    ...trigShapes,
    { type: 'line', x0: t[0], x1: t[t.length - 1], y0: p.threshold,  y1: p.threshold,
      xref: 'x', yref: 'y', line: { color: '#7c2bc8', width: 1, dash: 'dash' } },
    { type: 'line', x0: t[0], x1: t[t.length - 1], y0: -p.threshold, y1: -p.threshold,
      xref: 'x', yref: 'y', line: { color: '#7c2bc8', width: 1, dash: 'dash' } },
  ];

  const timeLayout = (title, shapes) => ({
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 46, r: 8, t: 24, b: 36 },
    font: { size: 10, family: 'inherit' },
    showlegend: false,
    xaxis: { title: { text: 'Time (s)', font: { size: 10 } }, gridcolor: gridColor, tickfont: { size: 9 } },
    yaxis: { gridcolor: gridColor, tickfont: { size: 9 } },
    shapes,
    annotations: [{
      text: title, x: 0.01, y: 0.97, xref: 'paper', yref: 'paper',
      xanchor: 'left', yanchor: 'top',
      font: { size: 10, weight: 600, color: '#3a2e1d' }, showarrow: false,
    }],
  });

  Plotly.react('wav-ham-plot',
    [{ x: t, y: ham, type: 'scatter', mode: 'lines',
       line: { color: '#c62828', width: 1 } }],
    timeLayout('Hammer', thrShapes), PCFG);

  Plotly.react('wav-mic-plot',
    [{ x: t, y: mic, type: 'scatter', mode: 'lines',
       line: { color: '#1565c0', width: 1 } }],
    timeLayout('Microphone', trigShapes), PCFG);

  // ── FRF ───────────────────────────────────────────────────────────────────
  if (freqs_js && nHits > 0) {
    const freqs = Array.from(freqs_js);
    const Hdb   = Array.from(Hdb_js);
    const coh   = Array.from(coh_js);

    let yRange = _S.yMin != null && _S.yMax != null
      ? [_S.yMin, _S.yMax]
      : undefined;

    if (!yRange) {
      const allY = Hdb.filter(v => isFinite(v) && v > -200);
      if (allY.length) {
        allY.sort((a, b) => a - b);
        const maxY = allY[Math.floor(allY.length * 0.99)];
        yRange = [maxY - _S.yDbRange, maxY + 2];
      }
    }

    const coBottom = yRange ? yRange[0] : -40;
    const coTop    = yRange ? yRange[0] + (yRange[1] - yRange[0]) * 0.25 : -30;
    const xRange   = _S.xLog
      ? [Math.log10(Math.max(_S.xMin, 1)), Math.log10(_S.xMax)]
      : [_S.xMin, _S.xMax];

    _wireRelayout();
    Plotly.react('wav-frf-plot', [
      { x: freqs, y: Hdb,
        type: 'scatter', mode: 'lines', name: fname_short,
        line: { color: '#6a1b9a', width: 1 } },
      { x: freqs,
        y: coh.map(c => coBottom + Math.max(0, Math.min(1, c)) * (coTop - coBottom)),
        type: 'scatter', mode: 'lines', name: 'Coherence',
        line: { color: '#1565c0', width: 1 },
        showlegend: false, hoverinfo: 'skip' },
    ], {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { l: 58, r: 20, t: 12, b: 50 },
      font: { size: 11, family: 'inherit' },
      showlegend: true,
      legend: { font: { size: 9 }, x: 1, xanchor: 'right', y: 1 },
      xaxis: {
        type: _S.xLog ? 'log' : 'linear',
        title: { text: 'Frequency (Hz)', font: { size: 11 } },
        range: xRange, gridcolor: gridColor, tickfont: { size: 10 },
      },
      yaxis: {
        title: { text: 'Intensity (dB)', font: { size: 11 } },
        range: yRange, gridcolor: gridColor, tickfont: { size: 10 },
      },
      autosize: true,
    }, { ...PCFG, displayModeBar: true, displaylogo: false,
         modeBarButtonsToRemove: ['sendDataToCloud'] });

  } else {
    // No hits — clear the FRF plot with a message
    Plotly.react('wav-frf-plot',
      [{ x: [], y: [], type: 'scatter', mode: 'lines', showlegend: false }],
      { paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
        margin: { l: 58, r: 20, t: 12, b: 50 },
        annotations: [{
          text: nHits === 0
            ? `No hits detected above threshold (${p.threshold} V) — adjust in Settings`
            : 'Loading…',
          x: 0.5, y: 0.5, xref: 'paper', yref: 'paper',
          xanchor: 'center', yanchor: 'middle',
          font: { size: 13, color: '#7a6749' }, showarrow: false,
        }],
      }, PCFG);
  }
};

window.onWavError = function(fname, msg) {
  const short = String(fname).split('/').pop().split('\\').pop();
  _setStatus(`Error — ${short}: ${msg}`);
};

// ── Plot controls ─────────────────────────────────────────────────────────────
window.wavRescaleY = function() {
  _S.yMin = null; _S.yMax = null;
  if (_activeIdx >= 0 && _pyReady) wavSelectFile(_activeIdx);
};

window.wavToggleXLog = function() {
  _S.xLog = !_S.xLog;
  const b = document.getElementById('x-log-btn');
  if (b) { b.textContent = _S.xLog ? 'X=log' : 'X=lin'; b.classList.toggle('active', _S.xLog); }
  if (_activeIdx >= 0 && _pyReady) wavSelectFile(_activeIdx);
};

// Capture user pan/zoom — called once after Plotly initialises the FRF div
let _frfRelayoutWired = false;
function _wireRelayout() {
  if (_frfRelayoutWired) return;
  const el = document.getElementById('wav-frf-plot');
  if (!el || !el.on) return;
  _frfRelayoutWired = true;
  el.on('plotly_relayout', e => {
    if (e['yaxis.range[0]'] != null) { _S.yMin = e['yaxis.range[0]']; _S.yMax = e['yaxis.range[1]']; }
    else if (e['yaxis.autorange'])   { _S.yMin = null; _S.yMax = null; }
    if (e['xaxis.range[0]'] != null) {
      _S.xMin = _S.xLog ? Math.pow(10, e['xaxis.range[0]']) : e['xaxis.range[0]'];
      _S.xMax = _S.xLog ? Math.pow(10, e['xaxis.range[1]']) : e['xaxis.range[1]'];
    } else if (e['xaxis.autorange']) {
      _S.xMin = 100; _S.xMax = 12000;
    }
  });
}

// ── Preferences modal ─────────────────────────────────────────────────────────
window.wavPreferences = function() {
  const p = _loadPrefs();
  document.getElementById('wav-pref-threshold').value = p.threshold;
  document.getElementById('wav-pref-pre').value        = p.pre_trig_s;
  document.getElementById('wav-pref-post').value       = p.post_trig_s;
  document.getElementById('wav-pref-swap').checked     = p.swap_channels;
  document.getElementById('prefs-modal')?.classList.add('open');
};

window.wavSavePrefs = function() {
  const g = id => document.getElementById(id)?.value ?? '';
  const p = {
    threshold:     parseFloat(g('wav-pref-threshold'))   || 0.05,
    pre_trig_s:    parseFloat(g('wav-pref-pre'))          || 0.01,
    post_trig_s:   parseFloat(g('wav-pref-post'))         || 0.30,
    swap_channels: document.getElementById('wav-pref-swap')?.checked ?? false,
  };
  _savePrefs(p);
  if (window.pyWavApplySettings) {
    window.pyWavApplySettings(p.threshold, p.pre_trig_s, p.post_trig_s, p.swap_channels);
  }
  document.getElementById('prefs-modal')?.classList.remove('open');
  const msg = document.getElementById('prefs-save-msg');
  if (msg) { msg.textContent = 'Saved'; setTimeout(() => { msg.textContent = ''; }, 2500); }
  if (_activeIdx >= 0 && _pyReady) wavSelectFile(_activeIdx);
};

window.wavClosePrefs = function() {
  document.getElementById('prefs-modal')?.classList.remove('open');
};

window.wavHelp = function() { window.open('../../Docs/index.html', '_blank'); };

// ── Sidebar resizer ───────────────────────────────────────────────────────────
function _initResizer() {
  const resizer = document.getElementById('wav-resizer');
  const sidebar = document.querySelector('.wav-sidebar');
  if (!resizer || !sidebar) return;
  let dragging = false, startX = 0, startW = 0;
  resizer.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.classList.add('wav-resizing');
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(120, Math.min(420, startW + (e.clientX - startX)));
    sidebar.style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('wav-resizing');
    Plotly.Plots.resize('wav-ham-plot');
    Plotly.Plots.resize('wav-mic-plot');
    Plotly.Plots.resize('wav-frf-plot');
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  _initResizer();

  // Restore folder name display while we wait for permission check
  const storedName = localStorage.getItem('obieDataFolderName');
  if (storedName) document.getElementById('folder-name-ind').textContent = storedName;

  const handle = await loadDataFolderHandle();
  if (handle) {
    try {
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm === 'granted') await _applyFolder(handle);
    } catch (_) {}
  }
});
