/* ─────────────────────────────────────────────────────────────────────────────
 * wavreader.js — WAV Reader
 *
 * Browser port of LabVIEW Main_WAV_Reader.vi. This file is UI only: every
 * number on screen comes from main.py, which drives the canonical repo modules
 * (wavfileio, frf, trf_fileio). Nothing here computes DSP.
 *
 * LabVIEW state mapping:
 *   "load"   -> wrLoadWav()            "number"/"cursor" -> _scheduleAnalyze()
 *   "plot"   -> onWrHit / onWrFRF      "settings"        -> wrSavePrefs()
 *   "play"   -> wrPlay()               "export"          -> wrDoExport()
 * ───────────────────────────────────────────────────────────────────────────── */

const PCFG = { responsive: true, displayModeBar: false };
const HAS_FS = typeof window.showDirectoryPicker === 'function';

const GRID   = '#c0c4cc';
const C_HAM  = '#c62828';   // hammer — red, matching WAV Viewer
const C_MIC  = '#1565c0';   // microphone — blue
const C_FRF  = '#6a1b9a';   // FRF — purple
const C_CURS = '#c8a800';   // cursors — LabVIEW's yellow
const C_THR  = '#7c2bc8';   // threshold line — LabVIEW's purple

const MSG_MS = 2500;        // save-message timeout, consistent across all tools

// ── Defaults (LabVIEW front-panel values) ────────────────────────────────────
const DEFAULTS = {
  duration:  0.3,   offset:   0.001,
  positions: 12,    taps:     4,     setType:   'H',
  threshold: 0.2,   hamCutoff: 0.002, micCutoff: 0.3,
  xMin:      100,   xMax:     10000, dbRange:   45,
};

function _loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('obieWavReader_prefs') || '{}') };
  } catch (_) { return { ...DEFAULTS }; }
}
function _savePrefs(p) {
  localStorage.setItem('obieWavReader_prefs', JSON.stringify(p));
}

// ── Session state ────────────────────────────────────────────────────────────
const _S = {
  pyReady:   false,
  loaded:    false,
  duration:  0,      // file length in seconds
  sr:        0,
  fileName:  '',
  cur0:      0,      // cursor 0 — window start (s)
  cur1:      0,      // cursor 1 — window end (s)
  hits:      [],     // trigger times
  counts:    [],     // taps found per position
  activeHit: -1,
  activePos: -1,     // -1 = all hits
  xLog:      true,
  yMin:      null,
  yMax:      null,
  overviewT: [], overviewHam: [], overviewMic: [],
  exportDir: null,   // chosen destination DirectoryHandle
  pending:   [],     // files staged by Python during an export
  dirs:      null,   // { raw, TRF } DirectoryHandles for the run being exported
};

function _setStatus(msg, isErr) {
  const el = document.getElementById('wr-status');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}

function _flash(id, msg, isErr) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  setTimeout(() => { el.textContent = ''; el.classList.remove('err'); }, MSG_MS);
}

const _num = id => parseFloat(document.getElementById(id).value);
const _int = id => parseInt(document.getElementById(id).value, 10);

// ═════════════════════════════════════════════════════════════════════════════
// Parameters → Python
// ═════════════════════════════════════════════════════════════════════════════

/** Push the toolbar + prefs values into main.py. */
function _pushParams() {
  if (!_S.pyReady) return;
  const p = _loadPrefs();
  window.pyWrSetParams(JSON.stringify({
    duration:   _num('p-duration'),
    offset:     _num('p-offset'),
    positions:  _int('p-positions'),
    taps:       _int('p-taps'),
    set_type:   document.getElementById('p-settype').value.trim() || 'H',
    threshold:  _num('p-threshold'),
    ham_cutoff: p.hamCutoff,
    mic_cutoff: p.micCutoff,
    first_mic:  document.getElementById('first-ch-sel').value === 'mic',
    method:     document.getElementById('method-sel').value,
  }));
}

/** Frequency resolution is a consequence of Duration, not an input: one FFT
    over a Duration-long segment gives bins 1/Duration apart. Showing it read-only
    keeps the LabVIEW panel's information without pretending it can be set. */
function _updateFreqRes() {
  const d = _num('p-duration');
  const el = document.getElementById('p-freqres');
  el.textContent = (isFinite(d) && d > 0) ? `${(1 / d).toFixed(2)} Hz` : '—';
}

/** Mirror the toolbar values back into localStorage so they survive a reload. */
function _persistToolbar() {
  const p = _loadPrefs();
  p.duration  = _num('p-duration');
  p.offset    = _num('p-offset');
  p.positions = _int('p-positions');
  p.taps      = _int('p-taps');
  p.setType   = document.getElementById('p-settype').value.trim() || 'H';
  p.threshold = _num('p-threshold');
  _savePrefs(p);
}

let _analyzeTimer = null;
function _scheduleAnalyze() {
  clearTimeout(_analyzeTimer);
  _analyzeTimer = setTimeout(() => {
    if (_S.pyReady && _S.loaded) window.pyWrAnalyze(_S.cur0, _S.cur1);
  }, 140);
}

window.wrParamChanged = function() {
  _updateFreqRes();
  _persistToolbar();
  _pushParams();
  // "First channel" changes which array is the hammer, so the file has to be
  // re-parsed rather than just re-analysed.
  if (_firstChDirty()) { _reloadCurrentFile(); return; }
  _drawOverview();
  _scheduleAnalyze();
};

let _lastFirstCh = 'mic';
function _firstChDirty() {
  const v = document.getElementById('first-ch-sel').value;
  if (v === _lastFirstCh) return false;
  _lastFirstCh = v;
  return _S.loaded;
}

// ═════════════════════════════════════════════════════════════════════════════
// File loading
// ═════════════════════════════════════════════════════════════════════════════

let _lastFile = null;

window.wrLoadWav = async function(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  _lastFile = file;
  await _readAndSend(file);
};

function _reloadCurrentFile() {
  if (_lastFile) _readAndSend(_lastFile);
}

async function _readAndSend(file) {
  if (!_S.pyReady) { _setStatus('Still loading Python — try again in a moment.'); return; }
  _setStatus(`Reading ${file.name}…`);
  document.getElementById('wav-btn-text').textContent = '📂 Open WAV…';
  try {
    const buf = await file.arrayBuffer();
    _pushParams();
    window.pyWrLoad(new Uint8Array(buf), file.name);
  } catch (e) {
    _setStatus(`Could not read ${file.name}: ${e.message}`, true);
  }
}

window.onWrLoaded = function(t_js, ham_js, mic_js, sr, durationSec, fname, nCh) {
  _S.overviewT   = Array.from(t_js);
  _S.overviewHam = Array.from(ham_js);
  _S.overviewMic = Array.from(mic_js);
  _S.sr        = sr;
  _S.duration  = durationSec;
  _S.fileName  = fname;
  _S.loaded    = true;
  _S.activeHit = -1;
  _S.activePos = -1;

  // Cursors start at the full span, as LabVIEW's "load" state does.
  _S.cur0 = 0;
  _S.cur1 = durationSec;
  document.getElementById('p-cur0').value = _S.cur0.toFixed(3);
  document.getElementById('p-cur1').value = _S.cur1.toFixed(3);

  document.getElementById('file-name-ind').textContent = fname;
  document.getElementById('play-btn').disabled   = false;
  document.getElementById('reset-btn').disabled  = false;
  document.getElementById('export-btn').disabled = false;

  _setStatus(`${fname} · ${(sr / 1000).toFixed(1)} kHz · ${nCh} ch · ${durationSec.toFixed(2)} s — drag the yellow cursors to pick the section to export`);

  _drawOverview();
  _scheduleAnalyze();
};

window.onWrError = function(fname, msg) {
  _setStatus(`${fname}: ${msg}`, true);
};

// ═════════════════════════════════════════════════════════════════════════════
// Overview plot — "Complete Data Set" with two draggable cursors
// ═════════════════════════════════════════════════════════════════════════════

function _drawOverview() {
  if (!_S.loaded) return;
  const t = _S.overviewT;

  const shapes = [
    // Shaded selection between the cursors — not draggable itself, so dragging
    // it can't desync the shading from the two cursor lines.
    { type: 'rect', xref: 'x', yref: 'paper', editable: false,
      x0: _S.cur0, x1: _S.cur1, y0: 0, y1: 1,
      fillcolor: C_CURS, opacity: 0.10, line: { width: 0 }, layer: 'below' },
    // Cursor 0 / cursor 1 — editable, so they drag like LabVIEW's yellow cursors
    { type: 'line', xref: 'x', yref: 'paper', name: 'cur0', editable: true,
      x0: _S.cur0, x1: _S.cur0, y0: 0, y1: 1,
      line: { color: C_CURS, width: 3 } },
    { type: 'line', xref: 'x', yref: 'paper', name: 'cur1', editable: true,
      x0: _S.cur1, x1: _S.cur1, y0: 0, y1: 1,
      line: { color: C_CURS, width: 3 } },
  ];

  // Pad the x-axis a little past the data. On load the cursors sit at 0 and at
  // the file duration; without this they land exactly on the plot boundary,
  // where Plotly's 10px drag handle is half outside the plot and effectively
  // ungrabbable. The pad puts them comfortably inside from the very first draw.
  const pad = Math.max(_S.duration * 0.02, 1e-3);

  Plotly.react('wr-overview-plot', [
    { x: t, y: _S.overviewMic, type: 'scatter', mode: 'lines', name: 'Microphone',
      line: { color: C_MIC, width: 1 } },
    { x: t, y: _S.overviewHam, type: 'scatter', mode: 'lines', name: 'Hammer',
      line: { color: C_HAM, width: 1 } },
  ], {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 46, r: 10, t: 20, b: 30 },
    font: { size: 10, family: 'inherit' },
    showlegend: true,
    legend: { font: { size: 9 }, x: 1, xanchor: 'right', y: 1.25, orientation: 'h' },
    xaxis: { title: { text: 'Time (s)', font: { size: 10 } },
             gridcolor: GRID, tickfont: { size: 9 },
             range: [-pad, _S.duration + pad] },
    yaxis: { title: { text: 'Amplitude', font: { size: 10 } },
             gridcolor: GRID, tickfont: { size: 9 } },
    shapes,
    annotations: [{
      text: 'Complete Data Set', x: 0.01, y: 1.1, xref: 'paper', yref: 'paper',
      xanchor: 'left', yanchor: 'top',
      font: { size: 10, weight: 600 }, showarrow: false,
    }],
    // Dragging on this plot only ever moves a cursor. With the default 'zoom'
    // dragmode a near-miss rubber-bands a zoom box instead, which reads as the
    // cursor simply refusing to move.
    dragmode: false,
  }, { ...PCFG, edits: { shapePosition: true } }).then(_wireOverviewDrag);
}

let _overviewWired = false;
function _wireOverviewDrag() {
  if (_overviewWired) return;
  _overviewWired = true;
  const gd = document.getElementById('wr-overview-plot');
  if (!gd || typeof gd.on !== 'function') { _overviewWired = false; return; }
  gd.on('plotly_relayout', ev => {
    // Plotly reports moved shapes as "shapes[1].x0" etc.
    let moved = false;
    for (const key of Object.keys(ev)) {
      const m = key.match(/^shapes\[(\d+)\]\.x0$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      const x   = Math.max(0, Math.min(_S.duration, ev[key]));
      if (idx === 1) { _S.cur0 = x; moved = true; }
      if (idx === 2) { _S.cur1 = x; moved = true; }
    }
    if (!moved) return;
    if (_S.cur0 > _S.cur1) { const s = _S.cur0; _S.cur0 = _S.cur1; _S.cur1 = s; }
    document.getElementById('p-cur0').value = _S.cur0.toFixed(3);
    document.getElementById('p-cur1').value = _S.cur1.toFixed(3);
    _drawOverview();
    _scheduleAnalyze();
  });
}

window.wrCursorTyped = function() {
  if (!_S.loaded) return;
  let a = parseFloat(document.getElementById('p-cur0').value);
  let b = parseFloat(document.getElementById('p-cur1').value);
  if (!isFinite(a)) a = 0;
  if (!isFinite(b)) b = _S.duration;
  a = Math.max(0, Math.min(_S.duration, a));
  b = Math.max(0, Math.min(_S.duration, b));
  if (a > b) { const s = a; a = b; b = s; }
  _S.cur0 = a; _S.cur1 = b;
  document.getElementById('p-cur0').value = a.toFixed(3);
  document.getElementById('p-cur1').value = b.toFixed(3);
  _drawOverview();
  _scheduleAnalyze();
};

window.wrReset = function() {
  if (!_S.loaded) return;
  _S.cur0 = 0;
  _S.cur1 = _S.duration;
  document.getElementById('p-cur0').value = '0.000';
  document.getElementById('p-cur1').value = _S.duration.toFixed(3);
  _S.yMin = null; _S.yMax = null;
  _drawOverview();
  _scheduleAnalyze();
};

// ═════════════════════════════════════════════════════════════════════════════
// Analysis results
// ═════════════════════════════════════════════════════════════════════════════

window.onWrAnalyzed = function(trigs_js, counts_js, nHits, nPos,
                               freq_js, Hdb_js, coh_js, nUsed) {
  _S.hits   = Array.from(trigs_js);
  _S.counts = Array.from(counts_js);

  const want   = _int('p-positions') * _int('p-taps');
  const hitWrd = nHits === 1 ? 'hit' : 'hits';
  const short  = _S.fileName;
  let msg = `${short} · ${(_S.sr / 1000).toFixed(1)} kHz · window ${_S.cur0.toFixed(3)}–${_S.cur1.toFixed(3)} s · ${nHits} ${hitWrd} → ${nPos} position${nPos === 1 ? '' : 's'}`;
  if (nHits !== want) {
    msg += ` · expected ${want} (${_int('p-positions')} × ${_int('p-taps')}) — adjust the threshold or cursors`;
  }
  _setStatus(msg, nHits === 0);

  _renderPositionSelect(nPos);   // may clamp _S.activePos, so run it before the list
  _renderHitList();

  // Auto-select the first hit so the detail plots are never blank.
  if (nHits > 0) {
    const keep = _S.activeHit >= 0 && _S.activeHit < nHits ? _S.activeHit : 0;
    wrSelectHit(keep);
  } else {
    _clearDetailPlots();
  }

  // The FRF handed back here is always the all-hits average; if the user is
  // looking at one position, ask Python for that one instead.
  if (_S.activePos >= 0) {
    window.pyWrSelectPosition(_S.activePos);
  } else {
    _drawFRF(freq_js, Hdb_js, coh_js, 'All hits', nUsed, nHits);
  }
};

function _renderPositionSelect(nPos) {
  const sel = document.getElementById('frf-pos-sel');
  const prev = sel.value;
  const prefix = document.getElementById('p-settype').value.trim() || 'H';
  let html = '<option value="-1">All hits</option>';
  for (let p = 0; p < nPos; p++) {
    html += `<option value="${p}">${prefix}${String(p + 1).padStart(2, '0')}</option>`;
  }
  sel.innerHTML = html;
  sel.value = (prev && parseInt(prev, 10) < nPos) ? prev : '-1';
  _S.activePos = parseInt(sel.value, 10);
}

function _renderHitList() {
  const list = document.getElementById('wr-hit-list');
  if (!_S.hits.length) {
    list.innerHTML = '<div class="wr-no-hits">No hits above threshold in this window</div>';
    return;
  }
  const taps   = _int('p-taps');
  const prefix = document.getElementById('p-settype').value.trim() || 'H';
  const nPos   = Math.ceil(_S.hits.length / taps);

  let html = '';
  for (let p = 0; p < nPos; p++) {
    const start = p * taps;
    const end   = Math.min(start + taps, _S.hits.length);
    const n     = end - start;
    const label = `${prefix}${String(p + 1).padStart(2, '0')}`;
    const short = n < taps ? ' short' : '';
    const act   = p === _S.activePos ? ' active' : '';
    html += `<div class="wr-pos-hdr${short}${act}" onclick="wrSelectPosition(${p})">`
          + `<span>${label}</span><span class="count">${n}/${taps}</span></div>`;
    for (let i = start; i < end; i++) {
      const sel = i === _S.activeHit ? ' active' : '';
      html += `<div class="wr-hit-item${sel}" onclick="wrSelectHit(${i})">`
            + `tap ${i - start + 1}<span class="t">${_S.hits[i].toFixed(3)} s</span></div>`;
    }
  }
  list.innerHTML = html;
}

window.wrSelectHit = function(idx) {
  _S.activeHit = idx;
  _renderHitList();
  if (_S.pyReady) window.pyWrSelectHit(idx);
};

window.wrSelectPosition = function(pos) {
  _S.activePos = parseInt(pos, 10);
  document.getElementById('frf-pos-sel').value = String(_S.activePos);
  _renderHitList();
  if (_S.pyReady) window.pyWrSelectPosition(_S.activePos);
};

// ═════════════════════════════════════════════════════════════════════════════
// Detail plots — hammer, microphone, hammer spectrum
// ═════════════════════════════════════════════════════════════════════════════

function _detailLayout(title, yLabel, shapes, xTitle) {
  return {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 48, r: 10, t: 22, b: 34 },
    font: { size: 10, family: 'inherit' },
    showlegend: false,
    xaxis: { title: { text: xTitle || 'Time (s)', font: { size: 10 } },
             gridcolor: GRID, tickfont: { size: 9 } },
    yaxis: { title: { text: yLabel, font: { size: 10 } },
             gridcolor: GRID, tickfont: { size: 9 } },
    shapes: shapes || [],
    annotations: [{
      text: title, x: 0.01, y: 1.08, xref: 'paper', yref: 'paper',
      xanchor: 'left', yanchor: 'top',
      font: { size: 10, weight: 600 }, showarrow: false,
    }],
  };
}

window.onWrHit = function(t_js, ham_js, mic_js, f_js, spec_js,
                          idx, pos, tap, label) {
  const t    = Array.from(t_js);
  const ham  = Array.from(ham_js);
  const mic  = Array.from(mic_js);
  const p    = _loadPrefs();
  const thr  = _num('p-threshold');
  const tMin = t[0], tMax = t[t.length - 1];

  // Draggable purple threshold line, plus the hammer time cutoff as a dashed mark.
  const hamShapes = [
    // Shape 0 is the one the user drags to set the threshold — the mirror line
    // and the cutoff marker are locked so only one handle changes the value.
    { type: 'line', xref: 'x', yref: 'y', editable: true,
      x0: tMin, x1: tMax, y0: thr, y1: thr,
      line: { color: C_THR, width: 1.5, dash: 'dash' } },
    { type: 'line', xref: 'x', yref: 'y', editable: false,
      x0: tMin, x1: tMax, y0: -thr, y1: -thr,
      line: { color: C_THR, width: 1, dash: 'dot' } },
    { type: 'line', xref: 'x', yref: 'paper', editable: false,
      x0: p.hamCutoff, x1: p.hamCutoff,
      y0: 0, y1: 1, line: { color: '#888', width: 1, dash: 'dot' } },
  ];
  const micShapes = [
    { type: 'line', xref: 'x', yref: 'paper', editable: false,
      x0: p.micCutoff, x1: p.micCutoff,
      y0: 0, y1: 1, line: { color: '#888', width: 1, dash: 'dot' } },
  ];

  Plotly.react('wr-ham-plot',
    [{ x: t, y: ham, type: 'scatter', mode: 'lines', line: { color: C_HAM, width: 1 } }],
    _detailLayout(`Hammer — ${label} tap ${tap + 1}`, 'Hammer (V)', hamShapes),
    { ...PCFG, edits: { shapePosition: true } }).then(_wireThresholdDrag);

  Plotly.react('wr-mic-plot',
    [{ x: t, y: mic, type: 'scatter', mode: 'lines', line: { color: C_MIC, width: 1 } }],
    _detailLayout('Microphone', 'Microphone (V)', micShapes), PCFG);

  Plotly.react('wr-spec-plot',
    [{ x: Array.from(f_js), y: Array.from(spec_js), type: 'scatter', mode: 'lines',
       line: { color: C_HAM, width: 1 } }],
    _detailLayout('Hammer Spectrum', 'Intensity (dB)', [], 'Frequency (Hz)'),
    PCFG);

  // The hammer is zeroed past its cutoff, so showing the whole segment leaves
  // the pulse an invisible sliver at the far left. Zoom to the live part, as the
  // LabVIEW panel's hammer plot does, leaving headroom to see the decay.
  const hamSpan = Math.max(p.hamCutoff * 4, 0.005);
  Plotly.relayout('wr-ham-plot', { 'xaxis.range': [-p.offset, hamSpan] });

  // Log-x for the spectrum, matching the LabVIEW panel's 200 Hz–10 kHz sweep.
  Plotly.relayout('wr-spec-plot', {
    'xaxis.type': 'log',
    'xaxis.range': [Math.log10(Math.max(p.xMin, 1)), Math.log10(p.xMax)],
    'yaxis.range': [-p.dbRange, 2],
  });
};

let _thrWired = false;
function _wireThresholdDrag() {
  if (_thrWired) return;
  _thrWired = true;
  const gd = document.getElementById('wr-ham-plot');
  if (!gd || typeof gd.on !== 'function') { _thrWired = false; return; }
  gd.on('plotly_relayout', ev => {
    // Shape 0 is the positive threshold line; dragging it sets the threshold.
    const key = 'shapes[0].y0';
    if (!(key in ev)) return;
    const v = Math.abs(ev[key]);
    if (!isFinite(v) || v <= 0) return;
    document.getElementById('p-threshold').value = v.toFixed(4);
    _persistToolbar();
    _pushParams();
    _scheduleAnalyze();
  });
}

function _clearDetailPlots() {
  // Axes hidden — an empty Plotly plot otherwise draws a meaningless -1..2 grid.
  const blank = msg => ({
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 48, r: 10, t: 22, b: 34 },
    xaxis: { visible: false }, yaxis: { visible: false },
    annotations: [{ text: msg, x: 0.5, y: 0.5, xref: 'paper', yref: 'paper',
                    xanchor: 'center', yanchor: 'middle',
                    font: { size: 11, color: '#5a5f6a' }, showarrow: false }],
  });
  Plotly.react('wr-ham-plot',  [], blank('No hit selected'), PCFG);
  Plotly.react('wr-mic-plot',  [], blank(''), PCFG);
  Plotly.react('wr-spec-plot', [], blank(''), PCFG);
}

// ═════════════════════════════════════════════════════════════════════════════
// FRF plot
// ═════════════════════════════════════════════════════════════════════════════

window.onWrFRF = function(freq_js, Hdb_js, coh_js, label, nUsed) {
  _drawFRF(freq_js, Hdb_js, coh_js, label, nUsed, _S.hits.length);
};

function _drawFRF(freq_js, Hdb_js, coh_js, label, nUsed, nHits) {
  const p = _loadPrefs();

  if (!freq_js || !nUsed) {
    Plotly.react('wr-frf-plot', [], {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { l: 58, r: 20, t: 12, b: 50 },
      annotations: [{
        text: nHits === 0
          ? `No hits above threshold (${_num('p-threshold')}) in this window`
          : 'No FRF for this selection',
        x: 0.5, y: 0.5, xref: 'paper', yref: 'paper',
        xanchor: 'center', yanchor: 'middle',
        font: { size: 13, color: '#5a5f6a' }, showarrow: false,
      }],
    }, PCFG);
    return;
  }

  const freq = Array.from(freq_js);
  const Hdb  = Array.from(Hdb_js);
  const coh  = coh_js ? Array.from(coh_js) : null;

  let yRange = (_S.yMin != null && _S.yMax != null) ? [_S.yMin, _S.yMax] : null;
  if (!yRange) {
    // Auto-scale off the 99th percentile so a single spike doesn't squash the curve.
    const inBand = [];
    for (let i = 0; i < freq.length; i++) {
      if (freq[i] >= p.xMin && freq[i] <= p.xMax && isFinite(Hdb[i]) && Hdb[i] > -200) {
        inBand.push(Hdb[i]);
      }
    }
    if (inBand.length) {
      inBand.sort((a, b) => a - b);
      const top = inBand[Math.floor(inBand.length * 0.99)];
      yRange = [top - p.dbRange, top + 2];
    } else {
      yRange = [-p.dbRange, 2];
    }
  }

  // Coherence rides in the bottom quarter of the panel, as in Explore.
  const coBottom = yRange[0];
  const coTop    = yRange[0] + (yRange[1] - yRange[0]) * 0.25;

  const traces = [{
    x: freq, y: Hdb, type: 'scatter', mode: 'lines',
    name: `${label} (${nUsed} hit${nUsed === 1 ? '' : 's'})`,
    line: { color: C_FRF, width: 1.2 },
  }];
  if (coh) {
    traces.push({
      x: freq,
      y: coh.map(c => coBottom + Math.max(0, Math.min(1, c)) * (coTop - coBottom)),
      type: 'scatter', mode: 'lines', name: 'Coherence',
      line: { color: C_MIC, width: 1, dash: 'dot' },
      hoverinfo: 'skip',
    });
  }

  const xRange = _S.xLog
    ? [Math.log10(Math.max(p.xMin, 1)), Math.log10(p.xMax)]
    : [p.xMin, p.xMax];

  Plotly.react('wr-frf-plot', traces, {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    margin: { l: 58, r: 20, t: 12, b: 50 },
    font: { size: 11, family: 'inherit' },
    showlegend: true,
    legend: { font: { size: 9 }, x: 1, xanchor: 'right', y: 1 },
    xaxis: { type: _S.xLog ? 'log' : 'linear',
             title: { text: 'Frequency (Hz)', font: { size: 11 } },
             range: xRange, gridcolor: GRID, tickfont: { size: 10 } },
    yaxis: { title: { text: 'Intensity (dB)', font: { size: 11 } },
             range: yRange, gridcolor: GRID, tickfont: { size: 10 } },
    autosize: true,
  }, { ...PCFG, displayModeBar: true, displaylogo: false }).then(_wireFRFRelayout);
}

let _frfWired = false;
function _wireFRFRelayout() {
  if (_frfWired) return;
  _frfWired = true;
  const gd = document.getElementById('wr-frf-plot');
  if (!gd || typeof gd.on !== 'function') { _frfWired = false; return; }
  gd.on('plotly_relayout', ev => {
    if (ev['yaxis.range[0]'] != null) {
      _S.yMin = ev['yaxis.range[0]'];
      _S.yMax = ev['yaxis.range[1]'];
    }
    if (ev['yaxis.autorange']) { _S.yMin = null; _S.yMax = null; }
  });
}

window.wrRescaleY = function() {
  _S.yMin = null; _S.yMax = null;
  if (_S.pyReady && _S.loaded) window.pyWrSelectPosition(_S.activePos);
};

window.wrToggleXLog = function() {
  _S.xLog = !_S.xLog;
  document.getElementById('xlog-btn').textContent = _S.xLog ? 'X: Log' : 'X: Linear';
  if (_S.pyReady && _S.loaded) window.pyWrSelectPosition(_S.activePos);
};

// ═════════════════════════════════════════════════════════════════════════════
// Playback
// ═════════════════════════════════════════════════════════════════════════════

let _audioCtx = null;
let _audioSrc = null;

window.wrPlay = function() {
  if (!_S.loaded || !_S.pyReady) return;
  if (_audioSrc) { try { _audioSrc.stop(); } catch (_) {} _audioSrc = null; }
  window.pyWrGetAudio(_S.cur0, _S.cur1);
};

window.onWrAudio = function(samples_js, sr) {
  if (!samples_js) { _setStatus('Nothing to play in this window.'); return; }
  const data = Float32Array.from(samples_js);
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const buf = _audioCtx.createBuffer(1, data.length, sr);
    buf.copyToChannel(data, 0);
    const src = _audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(_audioCtx.destination);
    src.onended = () => { _audioSrc = null; };
    src.start();
    _audioSrc = src;
  } catch (e) {
    _setStatus(`Playback failed: ${e.message}`, true);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Settings modal
// ═════════════════════════════════════════════════════════════════════════════

window.wrPreferences = function() {
  _populatePrefsForm(_loadPrefs());
  document.getElementById('prefs-modal').classList.add('open');
};
window.wrClosePrefs = function() {
  document.getElementById('prefs-modal').classList.remove('open');
};

function _populatePrefsForm(p) {
  document.getElementById('s-threshold').value = p.threshold;
  document.getElementById('s-duration').value  = p.duration;
  document.getElementById('s-offset').value    = p.offset;
  document.getElementById('s-hamcut').value    = p.hamCutoff;
  document.getElementById('s-miccut').value    = p.micCutoff;
  document.getElementById('s-positions').value = p.positions;
  document.getElementById('s-taps').value      = p.taps;
  document.getElementById('s-settype').value   = p.setType;
  document.getElementById('s-xmin').value      = p.xMin;
  document.getElementById('s-xmax').value      = p.xMax;
  document.getElementById('s-dbrange').value   = p.dbRange;
}

window.wrSavePrefs = function() {
  const p = {
    ..._loadPrefs(),
    threshold: _num('s-threshold'),
    duration:  _num('s-duration'),
    offset:    _num('s-offset'),
    hamCutoff: _num('s-hamcut'),
    micCutoff: _num('s-miccut'),
    positions: _int('s-positions'),
    taps:      _int('s-taps'),
    setType:   document.getElementById('s-settype').value.trim() || 'H',
    xMin:      _num('s-xmin'),
    xMax:      _num('s-xmax'),
    dbRange:   _num('s-dbrange'),
  };
  _savePrefs(p);
  _applyPrefsToToolbar(p);
  _pushParams();
  _S.yMin = null; _S.yMax = null;
  _scheduleAnalyze();
  _flash('prefs-msg', 'Saved');
};

window.wrResetPrefs = function() {
  _savePrefs({ ...DEFAULTS });
  _populatePrefsForm(DEFAULTS);
  _applyPrefsToToolbar(DEFAULTS);
  _pushParams();
  _S.yMin = null; _S.yMax = null;
  _scheduleAnalyze();
  _flash('prefs-msg', 'Reset to defaults');
};

function _applyPrefsToToolbar(p) {
  document.getElementById('p-duration').value  = p.duration;
  document.getElementById('p-offset').value    = p.offset;
  document.getElementById('p-positions').value = p.positions;
  document.getElementById('p-taps').value      = p.taps;
  document.getElementById('p-settype').value   = p.setType;
  document.getElementById('p-threshold').value = p.threshold;
  _updateFreqRes();
}

// ═════════════════════════════════════════════════════════════════════════════
// Export — raw/*.wav + TRF/*.trf, same layout Acquire writes
// ═════════════════════════════════════════════════════════════════════════════

window.wrExport = function() {
  if (!_S.loaded) return;
  const stem = _S.fileName.replace(/\.wav$/i, '');
  const inst = document.getElementById('e-instrument');
  const test = document.getElementById('e-test');
  if (!inst.value) inst.value = stem;
  if (!test.value) test.value = 'Test 1';
  _updateExportSummary();
  document.getElementById('export-modal').classList.add('open');
};

window.wrCloseExport = function() {
  document.getElementById('export-modal').classList.remove('open');
};

function _updateExportSummary() {
  const taps = _int('p-taps');
  const nPos = Math.ceil(_S.hits.length / taps);
  const el   = document.getElementById('e-summary');
  el.innerHTML =
    `${_S.hits.length} hit${_S.hits.length === 1 ? '' : 's'} → `
    + `<strong>${_S.hits.length}</strong> WAV file${_S.hits.length === 1 ? '' : 's'} in <code>raw/</code> and `
    + `<strong>${nPos}</strong> TRF file${nPos === 1 ? '' : 's'} in <code>TRF/</code>`;
}

window.wrPickFolder = async function() {
  if (!HAS_FS) {
    _flash('export-msg', 'Needs Chrome or Edge', true);
    return;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    _S.exportDir = dir;
    await saveDataFolderHandle(dir);
    // Keeps the settings/templates/bands/colors folders in step with every
    // other tool, and tells the user when this is a brand-new data folder.
    try {
      const { isNew } = await openObieAppSettings(dir);
      if (isNew) alert('This is a new Data Folder and I moved over the default settings folder.');
    } catch (_) {}
    document.getElementById('e-folder-hint').textContent = `Writing into "${dir.name}"`;
  } catch (e) {
    if (e.name !== 'AbortError') _flash('export-msg', `Folder error: ${e.message}`, true);
  }
};

window.wrDoExport = async function() {
  if (!_S.exportDir) { _flash('export-msg', 'Choose a destination folder first', true); return; }
  if (!_S.hits.length) { _flash('export-msg', 'No hits to export', true); return; }

  const instrument = document.getElementById('e-instrument').value.trim();
  const test       = document.getElementById('e-test').value.trim();
  if (!instrument || !test) { _flash('export-msg', 'Instrument and test name are required', true); return; }

  const btn = document.getElementById('e-go');
  btn.disabled = true;
  document.getElementById('export-msg').textContent = 'Exporting…';

  try {
    const instH = await _S.exportDir.getDirectoryHandle(instrument, { create: true });
    const testH = await instH.getDirectoryHandle(test, { create: true });
    _S.dirs = {
      raw: await testH.getDirectoryHandle('raw', { create: true }),
      TRF: await testH.getDirectoryHandle('TRF', { create: true }),
    };
    _S.pending = [];
    window.pyWrExport(test);      // Python streams files back via onWrFile
  } catch (e) {
    btn.disabled = false;
    _flash('export-msg', `Export failed: ${e.message}`, true);
  }
};

/** Python hands one finished file over at a time. */
window.onWrFile = function(kind, name, bytes) {
  _S.pending.push({ kind: String(kind), name: String(name), bytes });
};

window.onWrExportDone = async function(nWav, nTrf, err) {
  const btn = document.getElementById('e-go');
  if (err) {
    btn.disabled = false;
    _flash('export-msg', err, true);
    return;
  }
  let written = 0;
  try {
    for (const f of _S.pending) {
      const dir = _S.dirs[f.kind];
      if (!dir) continue;
      const fh = await dir.getFileHandle(f.name, { create: true });
      const w  = await fh.createWritable();
      await w.write(f.bytes);
      await w.close();
      written++;
    }
  } catch (e) {
    btn.disabled = false;
    _flash('export-msg', `Write failed after ${written} files: ${e.message}`, true);
    return;
  } finally {
    _S.pending = [];
  }
  btn.disabled = false;
  _flash('export-msg', `Wrote ${nWav} WAV + ${nTrf} TRF`);
  _setStatus(`Exported ${nWav} WAV and ${nTrf} TRF file${nTrf === 1 ? '' : 's'} to "${_S.exportDir.name}".`);
};

// ═════════════════════════════════════════════════════════════════════════════
// Misc
// ═════════════════════════════════════════════════════════════════════════════

window.wrHelp = function() { window.open('../../Docs/experimental.html#wavreader', '_blank'); };
window.wrTips = function() { window.open('../../Docs/shortcuts.html', '_blank'); };

function _initResizer() {
  const bar  = document.getElementById('wr-resizer');
  const side = document.getElementById('wr-sidebar');
  let dragging = false;
  bar.addEventListener('mousedown', e => {
    dragging = true;
    bar.classList.add('dragging');
    document.body.classList.add('wr-resizing');
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(120, Math.min(400, e.clientX - side.getBoundingClientRect().left));
    side.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    document.body.classList.remove('wr-resizing');
    ['wr-overview-plot', 'wr-ham-plot', 'wr-mic-plot', 'wr-spec-plot', 'wr-frf-plot']
      .forEach(id => { try { Plotly.Plots.resize(id); } catch (_) {} });
  });
}

window.onPyReady = function() {
  _S.pyReady = true;
  _pushParams();
  _setStatus('Ready — open a two-channel WAV recording (hammer + microphone).');
};

document.addEventListener('DOMContentLoaded', () => {
  _applyPrefsToToolbar(_loadPrefs());
  _updateFreqRes();
  _lastFirstCh = document.getElementById('first-ch-sel').value;
  document.getElementById('xlog-btn').textContent = _S.xLog ? 'X: Log' : 'X: Linear';
  _initResizer();
  _clearDetailPlots();

  // Offer the already-connected data folder as the export destination, so the
  // usual case needs no second folder pick.
  loadDataFolderHandle().then(async handle => {
    if (!handle) return;
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return;
      _S.exportDir = handle;
      document.getElementById('e-folder-hint').textContent = `Writing into "${handle.name}"`;
    } catch (_) {}
  }).catch(() => {});
});
