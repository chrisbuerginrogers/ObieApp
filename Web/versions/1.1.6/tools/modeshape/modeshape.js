'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// modeshape.js — Modal Analysis Tool
// Roving-hammer, fixed-accelerometer FRF acquisition + 3-D mode-shape animation.
// ═══════════════════════════════════════════════════════════════════════════════

// ── AudioWorklet blob ─────────────────────────────────────────────────────────
const WORKLET_SRC = `
class ModalCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp[0] && inp[0].length > 0) {
      const L = inp[0];
      const R = inp.length > 1 && inp[1] && inp[1].length > 0 ? inp[1] : inp[0];
      this.port.postMessage({ l: L.slice(), r: R.slice() });
    }
    return true;
  }
}
registerProcessor('modal-capture', ModalCaptureProcessor);
`;

// ── Audio ─────────────────────────────────────────────────────────────────────
let audioCtx    = null;
let sourceNode  = null;
let workletNode = null;
let mediaStream = null;

const BATCH_SIZE = 2048;
let batchL    = new Float32Array(BATCH_SIZE);
let batchR    = new Float32Array(BATCH_SIZE);
let batchFill = 0;

// ── Geometry ──────────────────────────────────────────────────────────────────
// Each node: { id, label, x, y, z }
// Each edge: [nodeIndexA, nodeIndexB]
let _geometry = {
  nodes: [
    { id: 0, label: '1', x: 0,    y: 0, z: 0 },
    { id: 1, label: '2', x: 0.25, y: 0, z: 0 },
    { id: 2, label: '3', x: 0.5,  y: 0, z: 0 },
    { id: 3, label: '4', x: 0.75, y: 0, z: 0 },
    { id: 4, label: '5', x: 1,    y: 0, z: 0 },
  ],
  edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
};
// working copy in geometry editor
let _geomDraft = null;

// ── Measurements ──────────────────────────────────────────────────────────────
// keyed by node index → { freq[], H1db[], coh[], nHits }  (magnitude, for FRF plot)
let _frfCache  = {};
let _tapCache  = {};   // node → [{freq, H1db}]
let _histCache = [];   // [{freq, H1db, label}]

// complex FRF for mode shape: node index string → { freq[], real[], imag[] }
let _complexFRFs = {};

// ── UI state ──────────────────────────────────────────────────────────────────
let _appState      = 'idle';
let _curNodeIdx    = 0;
let _posHits       = [];
let _nTaps         = 5;
let _activeTab     = 'acquire';

// last triggered window for re-drawing green cutoff line
let _lastTrigData  = null;

// ── Plot settings ─────────────────────────────────────────────────────────────
let _S = { xLog: true, xMin: 200, xMax: 7000, yMin: null, yMax: null, yDbRange: 38, dbOffset: 0 };
let _lineWidth = 0.5;
let _hamTimeCutoffS = 0.30;
let _micTimeCutoffS = 0.30;
let _preTrigS       = 0.01;
let _fftYRange  = [-25, 0];
let _hamYRange  = [-0.1, 1];
let _micYRange  = [-1, 1];
let _fftXRange  = [200, 10000];
let _hamXRange  = [0, 0.05];
let _micXRange  = [0, 0.3];
let _showHistory = true;
let _prevOpacity = 0.70;

// ── Mode shape state ──────────────────────────────────────────────────────────
let _modeFreqHz  = 1000;
let _modeAmp     = 1.0;
let _deformAxis  = 'z';      // 'x' | 'y' | 'z'
let _animRunning = false;
let _animRafId   = null;
let _animStart   = null;
let _ANIM_HZ     = 0.4;      // visual oscillation speed (not measurement freq)

// ── Data folder / study ───────────────────────────────────────────────────────
let _rootDirHandle = null;
let _studyHandle   = null;
let _rawHandle     = null;
let _studyName     = '';

// ── Colour palette ────────────────────────────────────────────────────────────
const PALETTE = ['#ff6f00','#2196f3','#4caf50','#e91e63','#9c27b0',
                 '#00bcd4','#ff5722','#8bc34a','#ffc107','#607d8b'];

// ── Plotly config ──────────────────────────────────────────────────────────────
const PCFG = { responsive: true, displayModeBar: false };

const MINI_BASE = {
  paper_bgcolor:'transparent', plot_bgcolor:'transparent',
  margin:{ l:44, r:8, t:18, b:28 },
  font:{ size:9, family:'inherit' }, showlegend:false,
  xaxis:{ gridcolor:'#c9cdd5', tickfont:{ size:8 }, zeroline:false },
  yaxis:{ gridcolor:'#c9cdd5', tickfont:{ size:8 }, zeroline:false },
};

function _miniLayout(title, xl, yl, xExtra, yExtra, shapes) {
  return {
    ...MINI_BASE,
    title:{ text:title, font:{ size:9 }, x:0.04 },
    xaxis:{ ...MINI_BASE.xaxis, title:{ text:xl, font:{ size:8 } }, ...(xExtra||{}) },
    yaxis:{ ...MINI_BASE.yaxis, title:{ text:yl, font:{ size:8 } }, ...(yExtra||{}) },
    ...(shapes ? { shapes } : {}),
  };
}

const hDot = (y, c) => ({ type:'line', xref:'paper', yref:'y', x0:0, x1:1, y0:y, y1:y, line:{ color:c, width:1.5, dash:'dot' } });
const vLine = (x, c) => ({ type:'line', xref:'x', yref:'paper', x0:x, x1:x, y0:0, y1:1, line:{ color:c, width:2 } });


// ═══════════════════════════════════════════════════════════════════════════════
// Python → JS callbacks
// ═══════════════════════════════════════════════════════════════════════════════

window.onPyReady = function() {
  _initPlots();
  _pushGeometryToPython();
  _applySettingsToPython();
  _renderNodeList();
  _renderBanner();
  _refreshOverlay();
};

window.onLivePlot = function() {};

window.onTriggered = function(t_js, ham_js, mic_js, thr) {
  const t = Array.from(t_js), ham = Array.from(ham_js), mic = Array.from(mic_js);
  _lastTrigData = { t, ham, mic, thr: Number(thr) };
  _drawTrigPlots(t, ham, mic, Number(thr));
};

window.onHammerFFT = function(freq_js, db_js) {
  const freq = Array.from(freq_js), db = Array.from(db_js);
  Plotly.react('ms-plot-fft', [{ x:freq, y:db, mode:'lines', line:{ color:'#7c2bc8', width:1 } }],
    _miniLayout('Hammer FFT', 'Hz', 'dB',
      { range:_fftXRange, type:'log' },
      { range:_fftYRange },
      [hDot(_fftYRange[1], '#7c2bc8')]), PCFG);
};

window.onFRFUpdate = function(freq_js, H1db_js, coh_js, pos, nHits) {
  const freq = Array.from(freq_js), H1db = Array.from(H1db_js), coh = Array.from(coh_js);
  _frfCache[pos] = { freq, H1db, coh, nHits: Number(nHits) };
  _drawFRFPlot();
  _drawFRFRef();
  _updateDeleteBtn();
};

window.onTapFRF = function(freq_js, H1db_js, pos, hitIdx) {
  const freq = Array.from(freq_js), H1db = Array.from(H1db_js);
  if (!_tapCache[pos]) _tapCache[pos] = [];
  _tapCache[pos][hitIdx] = { freq, H1db };
  _drawFRFPlot();
};

window.onHistoryAdd = function(freq_js, H1db_js, label) {
  const freq = Array.from(freq_js), H1db = Array.from(H1db_js);
  _histCache.push({ freq, H1db, label: String(label) });
};

window.onPositionComplete = function(label, isLast) {
  document.getElementById('pos-complete-label').textContent =
    `Node ${label} complete!`;
  document.getElementById('pos-complete-next-btn').textContent =
    isLast ? 'Finish ✓' : 'Next Node →';
  _showModal('pos-complete-modal');
  // fetch complex FRFs for mode shape
  _fetchComplexFRFs();
};

window.onStateChange = function(jsonStr) {
  const s = JSON.parse(jsonStr);
  _appState   = s.state;
  _curNodeIdx = s.pos;
  _nTaps      = s.n_taps;
  _renderNodeList();
  _renderBanner();
  _updateStatusText(s);
  _updateStartBtn();
  _updateDeleteBtn();
  if (_appState === 'complete') {
    _fetchComplexFRFs();
    _showStatusMsg('All nodes complete — switch to Mode Shape tab to animate.');
  }
};

window.onBannerUpdate = function(jsonStr) {
  const arr = JSON.parse(jsonStr);
  _posHits = arr.map(a => a.hits);
  _renderBanner();
  _renderNodeList();
};

window.onSaveHit = async function(bytes, pos, hitN) {
  if (!_rawHandle) return;
  const label = String(pos + 1).padStart(2, '0');
  const n     = String(hitN).padStart(3, '0');
  await _writeFile(_rawHandle, `N${label}_${n}.wav`, bytes);
};

// Receive TRF bytes (already built with node coords by Python) and save to disk
window.onSaveTRF = async function(bytes, pos) {
  if (!_studyHandle || !bytes) return;
  try {
    await _writeFile(_studyHandle, `N${String(pos+1).padStart(2,'0')}.trf`, bytes);
  } catch(e) { console.warn('onSaveTRF failed', e); }
};

window.onSaveAvR = async function(bytes) {
  if (!_studyHandle) return;
  await _writeFile(_studyHandle, 'average.avr', bytes);
};

window.onDownload = function(bytes, filename) {
  if (!bytes || !filename) return;
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
};


// ═══════════════════════════════════════════════════════════════════════════════
// Audio setup
// ═══════════════════════════════════════════════════════════════════════════════

async function _startAudio() {
  const sr  = Number(document.getElementById('inp-sample-rate')?.value || 48000);
  const sel = document.getElementById('prefs-device');
  const deviceId = sel?.value || undefined;

  try {
    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const blobURL = URL.createObjectURL(blob);

    audioCtx = new AudioContext({ sampleRate: sr });
    await audioCtx.audioWorklet.addModule(blobURL);
    URL.revokeObjectURL(blobURL);

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });

    // Populate soundcard indicator
    const track = mediaStream.getAudioTracks()[0];
    const devLabel = track?.label || '';
    document.getElementById('ms-soundcard-ind').textContent = devLabel ? `🎤 ${devLabel}` : '';

    sourceNode  = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'modal-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });

    batchFill = 0;
    workletNode.port.onmessage = ({ data }) => {
      const L = data.l, R = data.r, n = L.length;
      let offset = 0;
      while (offset < n) {
        const take = Math.min(n - offset, BATCH_SIZE - batchFill);
        batchL.set(L.subarray(offset, offset + take), batchFill);
        batchR.set(R.subarray(offset, offset + take), batchFill);
        batchFill += take;
        offset += take;
        if (batchFill === BATCH_SIZE) {
          if (window.pyProcessAudio) window.pyProcessAudio(batchL, batchR);
          batchFill = 0;
        }
      }
    };

    sourceNode.connect(workletNode);
    workletNode.connect(audioCtx.destination);
    return true;
  } catch (e) {
    alert('Audio error: ' + e.message);
    return false;
  }
}

function _stopAudio() {
  if (window.pyStopAudio) window.pyStopAudio();
  try { workletNode?.disconnect(); sourceNode?.disconnect(); } catch(_) {}
  try { mediaStream?.getTracks().forEach(t => t.stop()); } catch(_) {}
  try { audioCtx?.close(); } catch(_) {}
  audioCtx = sourceNode = workletNode = mediaStream = null;
  document.getElementById('ms-soundcard-ind').textContent = '';
}

window.msToggleAcquire = async function() {
  if (_appState === 'idle' || _appState === 'complete') {
    if (!_studyHandle) { msSetStudy(); return; }
    const ok = await _startAudio();
    if (!ok) return;
    _applySettingsToPython();
    window.pyArm?.();
  } else {
    _stopAudio();
    window.pyStopAudio?.();
  }
};


// ═══════════════════════════════════════════════════════════════════════════════
// Settings application
// ═══════════════════════════════════════════════════════════════════════════════

function _applySettingsToPython() {
  if (!window.pyApplySettings) return;
  const g = id => parseFloat(document.getElementById(id)?.value || 0);
  const n = _geometry.nodes.length;
  window.pyApplySettings(
    g('inp-threshold'),
    g('inp-pre'),
    g('inp-post'),
    g('inp-ham-cut'),
    g('inp-taps'),
    n,
    g('inp-mic-cal'),
    g('inp-ham-cal'),
    g('inp-sample-rate'),
    document.getElementById('inp-swap-channels')?.checked || false,
    g('inp-mic-cut'),
    document.getElementById('prefs-device')?.value || ''
  );
  // sync display inputs
  document.getElementById('inp-thr-disp').value    = g('inp-threshold');
  document.getElementById('inp-ham-cut-disp').value = g('inp-ham-cut');
  document.getElementById('inp-mic-cut-disp').value = g('inp-mic-cut');
  _hamTimeCutoffS = g('inp-ham-cut');
  _micTimeCutoffS = g('inp-mic-cut');
  _preTrigS       = g('inp-pre');
}


// ═══════════════════════════════════════════════════════════════════════════════
// Toolbar / UI actions
// ═══════════════════════════════════════════════════════════════════════════════

window.msDeleteLastHit = function() { window.pyDeleteLastHit?.(); };
window.msClearNode     = function() { if (confirm('Clear all hits for this node?')) window.pyClearPosition?.(); };

window.msStartOver = function() {
  if (!confirm('Clear ALL node measurements and start over?')) return;
  _frfCache  = {};
  _tapCache  = {};
  _histCache = [];
  _complexFRFs = {};
  _stopAudio();
  window.pyResetAll?.();
  _clearFRFPlot();
  _clearModePlot();
};

window.msRepeatPosition = function() {
  _hideModal('pos-complete-modal');
  window.pyRepeatPosition?.();
};
window.msPausePosition = function() {
  _hideModal('pos-complete-modal');
  window.pyPausePosition?.();
};
window.msNextPosition = function() {
  _hideModal('pos-complete-modal');
  window.pyAdvancePosition?.();
};

window.msApplyThreshold = function(v) {
  document.getElementById('inp-threshold').value = v;
  _applySettingsToPython();
  if (_lastTrigData) _drawTrigPlots(_lastTrigData.t, _lastTrigData.ham, _lastTrigData.mic, _lastTrigData.thr);
};

window.msApplyHamCutoff = function(v) {
  document.getElementById('inp-ham-cut').value = v;
  _hamTimeCutoffS = Number(v);
  _applySettingsToPython();
  if (_lastTrigData) _drawTrigPlots(_lastTrigData.t, _lastTrigData.ham, _lastTrigData.mic, _lastTrigData.thr);
};

window.msApplyMicCutoff = function(v) {
  document.getElementById('inp-mic-cut').value = v;
  _micTimeCutoffS = Number(v);
  _applySettingsToPython();
  if (_lastTrigData) _drawTrigPlots(_lastTrigData.t, _lastTrigData.ham, _lastTrigData.mic, _lastTrigData.thr);
};

window.msRescaleFFT    = function() { _fftYRange  = null; Plotly.relayout('ms-plot-fft',    { 'yaxis.autorange': true }); };
window.msRescaleHammer = function() { _hamYRange  = null; Plotly.relayout('ms-plot-hammer', { 'yaxis.autorange': true }); };
window.msRescaleMic    = function() { _micYRange  = null; Plotly.relayout('ms-plot-mic',    { 'yaxis.autorange': true }); };
window.msRescaleY      = function() { _S.yMin = null; _S.yMax = null; _drawFRFPlot(); };

window.msSetYDbRange = function(v) {
  _S.yDbRange = Number(v);
  document.getElementById('ms-y-db-range').value = v;
  _drawFRFPlot();
};

window.msToggleXLog = function() {
  _S.xLog = !_S.xLog;
  document.getElementById('ms-xlog-btn').classList.toggle('active', _S.xLog);
  _drawFRFPlot();
  _drawFRFRef();
};

window.msToggleHistory = function(v) {
  _showHistory = v;
  _drawFRFPlot();
};

window.msHelp = function() { window.open('../../Docs/index.html', '_blank'); };


// ═══════════════════════════════════════════════════════════════════════════════
// Node list and banner rendering
// ═══════════════════════════════════════════════════════════════════════════════

function _renderNodeList() {
  const container = document.getElementById('node-list');
  if (!container) return;
  container.innerHTML = '';
  _geometry.nodes.forEach((node, i) => {
    const hits    = _posHits[i] || 0;
    const nTaps   = _nTaps || 5;
    const done    = hits >= nTaps;
    const current = i === _curNodeIdx && _appState !== 'idle' && _appState !== 'complete';
    const partial = hits > 0 && !done;

    const div = document.createElement('div');
    div.className = 'node-item' + (current ? ' current' : '') + (done ? ' done' : '');
    div.onclick = () => _jumpToNode(i);
    div.innerHTML =
      `<span class="node-status">${done ? '✓' : (current ? '▶' : '○')}</span>` +
      `<span class="node-lbl">${_esc(node.label)}</span>` +
      `<span class="node-coord">(${node.x},${node.y},${node.z})</span>` +
      (hits > 0 ? `<span style="font-size:9px;color:var(--muted);margin-left:auto">${hits}/${nTaps}</span>` : '');
    container.appendChild(div);
  });
}

function _renderBanner() {
  const container = document.getElementById('node-banner');
  if (!container) return;
  container.innerHTML = '';
  _geometry.nodes.forEach((node, i) => {
    const hits  = _posHits[i] || 0;
    const done  = hits >= _nTaps;
    const cur   = i === _curNodeIdx && _appState !== 'idle' && _appState !== 'complete';
    const chip  = document.createElement('span');
    chip.className = 'node-chip' + (done ? ' done' : (cur ? ' current' : (hits > 0 ? ' partial' : '')));
    chip.textContent = node.label;
    chip.title = `Node ${node.label}: ${hits}/${_nTaps} hits`;
    chip.onclick = () => _jumpToNode(i);
    container.appendChild(chip);
  });

  const banner = document.getElementById('ms-study-banner');
  if (banner) banner.textContent = _studyName ? _studyName + ' ·' : '';
}

function _jumpToNode(i) {
  if (window.pyJumpToNode && _appState !== 'idle') window.pyJumpToNode(i);
  else _curNodeIdx = i;
  _renderNodeList();
  _renderBanner();
}

function _updateStatusText(s) {
  const el = document.getElementById('ms-status-txt');
  if (!el) return;
  const stateMap = {
    idle:              'Idle — press ▶ Start to begin',
    armed:             `Armed — Node ${s.label} — Hit ${s.hit_n + 1}/${s.n_taps}`,
    triggered:         `Triggered — capturing…`,
    position_complete: `Node ${s.label} complete`,
    complete:          'All nodes measured — switch to Mode Shape tab',
  };
  el.textContent = stateMap[s.state] || s.state;
}

function _updateStartBtn() {
  const btn = document.getElementById('ms-start-btn');
  if (!btn) return;
  const running = _appState === 'armed' || _appState === 'triggered' || _appState === 'position_complete';
  btn.textContent = running ? '⏹ Stop' : '▶ Start';
  btn.classList.toggle('start', !running);
}

function _updateDeleteBtn() {
  const hits = _posHits[_curNodeIdx] || 0;
  const delBtn = document.getElementById('ms-delete-btn');
  if (delBtn) delBtn.disabled = hits === 0;
  const clrBtn = document.getElementById('ms-clear-btn');
  if (clrBtn) clrBtn.disabled = hits === 0;
}

function _showStatusMsg(msg) {
  const el = document.getElementById('ms-status-txt');
  if (el) { el.textContent = msg; el.style.color = 'var(--accent)'; }
  setTimeout(() => { if (el) el.style.color = ''; }, 3000);
}


// ═══════════════════════════════════════════════════════════════════════════════
// FRF Plots (acquire tab)
// ═══════════════════════════════════════════════════════════════════════════════

function _initPlots() {
  const emptyLayout = (xl, yl) => ({
    ...MINI_BASE,
    xaxis: { ...MINI_BASE.xaxis, title:{ text:xl, font:{ size:8 } } },
    yaxis: { ...MINI_BASE.yaxis, title:{ text:yl, font:{ size:8 } } },
  });
  Plotly.newPlot('ms-plot-fft',    [], emptyLayout('Hz','dB'), PCFG);
  Plotly.newPlot('ms-plot-hammer', [], emptyLayout('s','V'),   PCFG);
  Plotly.newPlot('ms-plot-mic',    [], emptyLayout('s','V'),   PCFG);
  _clearFRFPlot();
  _clearModePlot();
  _initFRFRefPlot();
  _populateDeviceList();
}

function _clearFRFPlot() {
  const layout = {
    paper_bgcolor:'transparent', plot_bgcolor:'transparent',
    margin:{ l:52, r:16, t:12, b:36 },
    font:{ size:10, family:'inherit' },
    xaxis:{ title:'Hz', type: _S.xLog ? 'log' : 'linear', gridcolor:'#c9cdd5', range:[ _S.xLog ? Math.log10(_S.xMin) : _S.xMin, _S.xLog ? Math.log10(_S.xMax) : _S.xMax ] },
    yaxis:{ title:'dB', gridcolor:'#c9cdd5', zeroline:false },
    showlegend:false,
  };
  Plotly.react('ms-frf-plot', [], layout, PCFG);

  // click on FRF plot to set mode shape frequency
  document.getElementById('ms-frf-plot').on('plotly_click', data => {
    if (data.points.length) {
      const f = data.points[0].x;
      _setModeFreqUI(f);
    }
  });
}

function _drawFRFPlot() {
  const traces = [];
  const nodeKeys = Object.keys(_frfCache).map(Number).sort((a, b) => a - b);

  // History (completed positions) first, faded
  if (_showHistory) {
    _histCache.forEach(h => {
      traces.push({ x:h.freq, y:h.H1db, mode:'lines', name:h.label, line:{ width:_lineWidth, color:'#aaa' }, opacity:_prevOpacity, hoverinfo:'name+x+y' });
    });
    // Individual taps (faded)
    nodeKeys.forEach(i => {
      const taps = _tapCache[i] || [];
      taps.forEach(t => {
        traces.push({ x:t.freq, y:t.H1db, mode:'lines', line:{ width:_lineWidth * 0.8, color:PALETTE[i % PALETTE.length] }, opacity:0.3, hoverinfo:'none', showlegend:false });
      });
    });
  }

  // Current averaged FRFs per node
  nodeKeys.forEach(i => {
    const d = _frfCache[i];
    if (!d || !d.freq.length) return;
    const node = _geometry.nodes[i];
    const lbl  = node ? `N${node.label}` : `N${i+1}`;
    const yAdj = d.H1db.map(v => v + _S.dbOffset);
    traces.push({ x:d.freq, y:yAdj, mode:'lines', name:lbl, line:{ width:_lineWidth + 0.5, color:PALETTE[i % PALETTE.length] }, hoverinfo:'name+x+y' });
  });

  // Compute y range from data
  let yMin = _S.yMin, yMax = _S.yMax;
  if (yMin == null || yMax == null) {
    let allY = [];
    traces.forEach(t => { if (t.y) allY = allY.concat(t.y); });
    if (allY.length) {
      const mn = Math.min(...allY.filter(isFinite));
      const mx = Math.max(...allY.filter(isFinite));
      yMax = Math.ceil(mx + 2);
      yMin = yMax - _S.yDbRange;
    }
  }

  const layout = {
    paper_bgcolor:'transparent', plot_bgcolor:'transparent',
    margin:{ l:52, r:16, t:12, b:36 },
    font:{ size:10, family:'inherit' },
    xaxis:{ title:'Hz', type: _S.xLog ? 'log' : 'linear', gridcolor:'#c9cdd5', range:[ _S.xLog ? Math.log10(_S.xMin) : _S.xMin, _S.xLog ? Math.log10(_S.xMax) : _S.xMax ] },
    yaxis:{ title:'dB', gridcolor:'#c9cdd5', zeroline:false, range:[yMin, yMax] },
    showlegend: traces.length > 1,
    legend:{ font:{ size:9 }, x:1, y:1, xanchor:'right' },
    // vertical line showing mode shape frequency
    shapes:[{ type:'line', xref:'x', yref:'paper', x0:_modeFreqHz, x1:_modeFreqHz, y0:0, y1:1, line:{ color:'#c62828', width:1.5, dash:'dash' } }],
    annotations:[{ xref:'x', yref:'paper', x:_modeFreqHz, y:0.98, text:`${Math.round(_modeFreqHz)}Hz`, showarrow:false, font:{ size:9, color:'#c62828' }, xanchor:'left' }],
  };
  Plotly.react('ms-frf-plot', traces, layout, PCFG);
}

function _drawTrigPlots(t, ham, mic, thr) {
  const hamVis = ham.filter((_, i) => t[i] >= _hamXRange[0] && t[i] <= _hamXRange[1]);
  const micVis = mic.filter((_, i) => t[i] >= _micXRange[0] && t[i] <= _micXRange[1]);
  const pkH = Math.max(0.05, ...hamVis.map(Math.abs));
  const pkM = Math.max(0.05, ...micVis.map(Math.abs));
  const hamY = _hamYRange || [-pkH * 1.2, pkH * 1.4];
  const micY = _micYRange || [-pkM * 1.2, pkM * 1.4];
  const hamCutX = _preTrigS + _hamTimeCutoffS;
  const micCutX = _preTrigS + _micTimeCutoffS;

  Plotly.react('ms-plot-hammer',
    [{ x:t, y:ham, mode:'lines', line:{ color:'#7c2bc8', width:1 } }],
    _miniLayout('Hammer', 's', 'V',
      { range:_hamXRange },
      { range:hamY },
      [hDot(thr, '#7c2bc8'), hDot(-thr, '#7c2bc8'), vLine(hamCutX, '#2e7d32')]), PCFG);

  Plotly.react('ms-plot-mic',
    [{ x:t, y:mic, mode:'lines', line:{ color:'#1565c0', width:1 } }],
    _miniLayout('Accel', 's', 'V',
      { range:_micXRange },
      { range:micY },
      [vLine(micCutX, '#2e7d32')]), PCFG);
}


// ═══════════════════════════════════════════════════════════════════════════════
// Mode Shape Tab
// ═══════════════════════════════════════════════════════════════════════════════

function msSwitchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.ms-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.ms-tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('panel-' + tab).classList.add('active');

  if (tab === 'modeshape') {
    _fetchComplexFRFs();
    setTimeout(() => { _renderModePlot(true); _drawFRFRef(); }, 100);
  }
}

function _initFRFRefPlot() {
  Plotly.newPlot('ms-frf-ref-plot', [], {
    paper_bgcolor:'transparent', plot_bgcolor:'transparent',
    margin:{ l:44, r:8, t:8, b:32 },
    font:{ size:9, family:'inherit' }, showlegend:false,
    xaxis:{ gridcolor:'#c9cdd5', tickfont:{ size:8 }, title:{ text:'Hz', font:{ size:8 } }, type: _S.xLog ? 'log' : 'linear' },
    yaxis:{ gridcolor:'#c9cdd5', tickfont:{ size:8 }, title:{ text:'dB', font:{ size:8 } }, zeroline:false },
  }, PCFG);

  document.getElementById('ms-frf-ref-plot').on('plotly_click', data => {
    if (data.points.length) _setModeFreqUI(data.points[0].x);
  });
}

function _drawFRFRef() {
  const traces = [];
  Object.keys(_frfCache).map(Number).sort((a,b)=>a-b).forEach(i => {
    const d = _frfCache[i];
    if (!d || !d.freq.length) return;
    traces.push({ x:d.freq, y:d.H1db, mode:'lines', line:{ width:1, color:PALETTE[i % PALETTE.length] }, hoverinfo:'x+y' });
  });

  const layout = {
    paper_bgcolor:'transparent', plot_bgcolor:'transparent',
    margin:{ l:44, r:8, t:8, b:32 },
    font:{ size:9, family:'inherit' }, showlegend:false,
    xaxis:{ gridcolor:'#c9cdd5', tickfont:{ size:8 }, title:{ text:'Hz', font:{ size:8 } }, type: _S.xLog ? 'log' : 'linear',
            range:[ _S.xLog ? Math.log10(_S.xMin) : _S.xMin, _S.xLog ? Math.log10(_S.xMax) : _S.xMax ] },
    yaxis:{ gridcolor:'#c9cdd5', tickfont:{ size:8 }, title:{ text:'dB', font:{ size:8 } }, zeroline:false },
    shapes:[{ type:'line', xref:'x', yref:'paper', x0:_modeFreqHz, x1:_modeFreqHz, y0:0, y1:1, line:{ color:'#c62828', width:2 } }],
  };
  Plotly.react('ms-frf-ref-plot', traces, layout, PCFG);
}

async function _fetchComplexFRFs() {
  if (!window.pyGetComplexFRFs) return;
  try {
    const json = window.pyGetComplexFRFs();
    _complexFRFs = JSON.parse(json);
    if (_activeTab === 'modeshape') _renderModePlot(false);
  } catch(e) { console.warn('complex FRF fetch failed', e); }
}

function msRefreshModeShape() {
  _fetchComplexFRFs().then(() => _renderModePlot(true));
}

// ─ Frequency / amplitude controls ────────────────────────────────────────────

window.msSetModeFreq = function(v) {
  _setModeFreqUI(Number(v));
};
window.msSetModeFreqSlider = function(v) {
  _setModeFreqUI(Number(v));
};

function _setModeFreqUI(f) {
  f = Math.max(1, Math.round(f));
  _modeFreqHz = f;
  document.getElementById('ms-freq-inp').value    = f;
  document.getElementById('ms-freq-slider').value  = f;
  document.getElementById('ms-freq-disp').textContent = f + ' Hz';
  if (_activeTab === 'acquire') _drawFRFPlot();
  if (_activeTab === 'modeshape') { _drawFRFRef(); _renderModePlot(false); }
}

window.msSetModeAmp = function(v) {
  _modeAmp = Math.max(0.001, Number(v));
};

window.msSetDeformAxis = function(v) {
  _deformAxis = v;
  if (_activeTab === 'modeshape') _renderModePlot(false);
};

// ─ Animation ──────────────────────────────────────────────────────────────────

window.msToggleAnimation = function() {
  if (_animRunning) {
    _stopAnimation();
  } else {
    _startAnimation();
  }
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

let _lastAnimFrame = 0;
function _animLoop(now) {
  if (!_animRunning) return;
  _animRafId = requestAnimationFrame(_animLoop);
  now = now || performance.now();
  if (now - _lastAnimFrame < 33) return;  // ~30fps cap
  _lastAnimFrame = now;
  const t = (now - _animStart) / 1000;
  _renderModePlot(false, t);
}

// ─ 3-D mode shape rendering ───────────────────────────────────────────────────

function _clearModePlot() {
  Plotly.newPlot('ms-mode-plot', [], {
    paper_bgcolor:'transparent', plot_bgcolor:'transparent',
    margin:{ l:0, r:0, t:20, b:0 },
    scene:{ bgcolor:'transparent', xaxis:{ visible:false }, yaxis:{ visible:false }, zaxis:{ visible:false } },
  }, PCFG);
}

function _interpComplexFRF(data, freqHz) {
  const fa = data.freq, re = data.real, im = data.imag;
  if (!fa || fa.length === 0) return { re: 0, im: 0 };
  if (freqHz <= fa[0])  return { re: re[0], im: im[0] };
  if (freqHz >= fa[fa.length-1]) return { re: re[fa.length-1], im: im[fa.length-1] };
  let lo = 0, hi = fa.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (fa[mid] <= freqHz) lo = mid; else hi = mid; }
  const t = (freqHz - fa[lo]) / (fa[hi] - fa[lo]);
  return { re: re[lo] + t*(re[hi]-re[lo]), im: im[lo] + t*(im[hi]-im[lo]) };
}

function _renderModePlot(resetCamera, t) {
  const nodes = _geometry.nodes;
  const edges = _geometry.edges;
  const N = nodes.length;
  t = t || 0;

  const measuredCount = Object.keys(_complexFRFs).length;

  document.getElementById('ms-no-data-msg').style.display = measuredCount === 0 ? 'flex' : 'none';
  document.getElementById('ms-mode-plot').style.display   = measuredCount === 0 ? 'none' : 'flex';

  if (measuredCount === 0) return;

  // Compute normalized complex mode shape at selected frequency
  const H = nodes.map((_, i) => {
    const d = _complexFRFs[String(i)];
    return d ? _interpComplexFRF(d, _modeFreqHz) : { re: 0, im: 0 };
  });

  // Normalize by max magnitude
  const maxMag = Math.max(1e-12, ...H.map(h => Math.sqrt(h.re**2 + h.im**2)));
  const Hn = H.map(h => ({ re: h.re/maxMag, im: h.im/maxMag }));

  // Deformation at time t (visual oscillation at _ANIM_HZ Hz)
  const phase = 2 * Math.PI * _ANIM_HZ * t;
  const defs = Hn.map(h => _modeAmp * (h.re * Math.cos(phase) - h.im * Math.sin(phase)));

  // Deformed node positions
  const xs = nodes.map((n, i) => n.x + (_deformAxis === 'x' ? defs[i] : 0));
  const ys = nodes.map((n, i) => n.y + (_deformAxis === 'y' ? defs[i] : 0));
  const zs = nodes.map((n, i) => n.z + (_deformAxis === 'z' ? defs[i] : 0));

  // Undeformed ghost positions
  const gx = nodes.map(n => n.x);
  const gy = nodes.map(n => n.y);
  const gz = nodes.map(n => n.z);

  // Edge lines (deformed)
  const ex = [], ey = [], ez = [];
  edges.forEach(([a, b]) => { ex.push(xs[a], xs[b], null); ey.push(ys[a], ys[b], null); ez.push(zs[a], zs[b], null); });

  // Ghost edge lines (undeformed)
  const gex = [], gey = [], gez = [];
  edges.forEach(([a, b]) => { gex.push(gx[a], gx[b], null); gey.push(gy[a], gy[b], null); gez.push(gz[a], gz[b], null); });

  // Node colors by deformation (only measured nodes colored; unmeasured = grey)
  const colors = nodes.map((_, i) => _complexFRFs[String(i)] ? defs[i] : null);
  const colorArr = colors.map((c, i) => c === null ? '#ccc' : undefined);
  const numericColors = colors.map(c => c === null ? 0 : c);

  const traces = [
    // Ghost structure (undeformed)
    { type:'scatter3d', mode:'lines', x:gex, y:gey, z:gez, line:{ color:'rgba(150,150,150,0.25)', width:3 }, hoverinfo:'none', showlegend:false, name:'ghost' },
    // Deformed edges
    { type:'scatter3d', mode:'lines', x:ex, y:ey, z:ez, line:{ color:'rgba(33,150,243,0.8)', width:4 }, hoverinfo:'none', showlegend:false, name:'structure' },
    // Nodes (colored by deformation)
    {
      type:'scatter3d', mode:'markers+text',
      x:xs, y:ys, z:zs,
      text:nodes.map(n => n.label),
      textposition:'top center',
      textfont:{ size:9 },
      marker:{
        size: nodes.map((_, i) => _complexFRFs[String(i)] ? 8 : 5),
        color: numericColors,
        colorscale:'RdBu',
        cmin: -1, cmax: 1,
        showscale: true,
        colorbar:{ len:0.5, thickness:12, title:{ text:'Norm.', side:'right', font:{ size:9 } }, tickfont:{ size:8 } },
        line:{ color:'rgba(0,0,0,0.3)', width:0.5 },
      },
      hovertemplate: nodes.map((n, i) => {
        const d = _complexFRFs[String(i)];
        return `Node ${n.label}<br>def=${d ? defs[i].toFixed(3) : 'N/A'}<extra></extra>`;
      }),
      showlegend:false,
      name:'nodes',
    },
  ];

  // Compute scene ranges for consistent scaling
  const allX = xs.concat(gx), allY = ys.concat(gy), allZ = zs.concat(gz);
  const [mnX,mxX] = [Math.min(...allX), Math.max(...allX)];
  const [mnY,mxY] = [Math.min(...allY), Math.max(...allY)];
  const [mnZ,mxZ] = [Math.min(...allZ), Math.max(...allZ)];
  const pad = (Math.max(mxX-mnX, mxY-mnY, mxZ-mnZ) * 0.3) + 0.01;

  const layout = {
    paper_bgcolor:'transparent', plot_bgcolor:'transparent',
    margin:{ l:0, r:0, t:30, b:0 },
    title:{ text:`Mode Shape @ ${Math.round(_modeFreqHz)} Hz`, font:{ size:12 }, x:0.5 },
    scene:{
      bgcolor:'rgba(245,247,250,0.5)',
      xaxis:{ title:'X', range:[mnX-pad,mxX+pad], gridcolor:'#ddd', zeroline:false },
      yaxis:{ title:'Y', range:[mnY-pad,mxY+pad], gridcolor:'#ddd', zeroline:false },
      zaxis:{ title:'Z', range:[mnZ-pad-_modeAmp, mxZ+pad+_modeAmp], gridcolor:'#ddd', zeroline:false },
      aspectmode:'manual',
      aspectratio:{ x: Math.max(0.3, mxX-mnX+0.01), y: Math.max(0.3, mxY-mnY+0.01), z: Math.max(0.3, mxZ-mnZ+0.1+_modeAmp) },
      camera: resetCamera ? { eye:{ x:1.5, y:1.5, z:1 } } : undefined,
    },
  };

  Plotly.react('ms-mode-plot', traces, layout, { ...PCFG, staticPlot: false });
}


// ═══════════════════════════════════════════════════════════════════════════════
// Geometry Editor Modal
// ═══════════════════════════════════════════════════════════════════════════════

window.msGeometry = function() {
  _geomDraft = JSON.parse(JSON.stringify(_geometry));
  _rebuildGeomTables();
  _showModal('geom-modal');
  requestAnimationFrame(_updateGeomPreview);
};

// ── Geometry preview canvas ───────────────────────────────────────────────────

window.geomPreviewUpdate = function() {
  _readGeomDraft();
  _updateGeomPreview();
};

function _updateGeomPreview() {
  const cv = document.getElementById('geom-preview-canvas');
  if (!cv) return;
  const rect = cv.getBoundingClientRect();
  const W = Math.round(rect.width) || 280, H = Math.round(rect.height) || 260;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f8f9fb'; ctx.fillRect(0, 0, W, H);

  const nodes = _geomDraft?.nodes || [];
  if (nodes.length === 0) {
    ctx.fillStyle = '#aaa'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No nodes', W/2, H/2);
    return;
  }

  const xs = nodes.map(n => +n.x), ys = nodes.map(n => +n.y);
  const mnX = Math.min(...xs), mxX = Math.max(...xs);
  const mnY = Math.min(...ys), mxY = Math.max(...ys);
  const rX = mxX - mnX || 1, rY = mxY - mnY || 1;
  const pad = 32;
  // Map to canvas (Y flipped: higher Y → up)
  const cx = n => pad + ((+n.x - mnX) / rX) * (W - 2*pad);
  const cy = n => H - pad - ((+n.y - mnY) / rY) * (H - 2*pad);

  // Edges
  ctx.strokeStyle = '#1565c0'; ctx.lineWidth = 2;
  (_geomDraft?.edges || []).forEach(([a, b]) => {
    const na = nodes[a], nb = nodes[b];
    if (!na || !nb) return;
    ctx.beginPath(); ctx.moveTo(cx(na), cy(na)); ctx.lineTo(cx(nb), cy(nb)); ctx.stroke();
  });

  // Nodes
  nodes.forEach((n, i) => {
    const x = cx(n), y = cy(n);
    ctx.fillStyle = '#ff6f00';
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = '#1a1a1a'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(String(n.label || i+1), x, y - 10);
  });
}

// ── Grid generator ────────────────────────────────────────────────────────────

window.geomGenerateGrid = function() {
  const rows = Math.max(1, parseInt(document.getElementById('geom-rows')?.value) || 3);
  const cols = Math.max(1, parseInt(document.getElementById('geom-cols')?.value) || 5);
  _geomDraft.nodes = [];
  _geomDraft.edges = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      _geomDraft.nodes.push({
        id: id,
        label: String(id + 1),
        x: cols > 1 ? c / (cols - 1) : 0,
        y: rows > 1 ? r / (rows - 1) : 0,
        z: 0,
      });
      id++;
    }
  }
  // Horizontal edges
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols - 1; c++)
      _geomDraft.edges.push([r*cols + c, r*cols + c + 1]);
  // Vertical edges
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < cols; c++)
      _geomDraft.edges.push([r*cols + c, (r+1)*cols + c]);
  _rebuildGeomTables();
  _updateGeomPreview();
};

window.msCloseGeom = function() { _hideModal('geom-modal'); };

window.msApplyGeom = function() {
  _readGeomDraft();
  const newN = _geomDraft.nodes.length;
  const oldN = _geometry.nodes.length;
  const hasData = Object.keys(_frfCache).length > 0;

  if (newN !== oldN && hasData) {
    if (!confirm(`Changing the number of nodes (${oldN} → ${newN}) will clear all measurements. Continue?`)) return;
    _frfCache = {}; _tapCache = {}; _histCache = []; _complexFRFs = {};
    window.pyResetAll?.();
    _clearFRFPlot();
    _clearModePlot();
  }

  _geometry = JSON.parse(JSON.stringify(_geomDraft));
  _saveGeometry();
  _pushGeometryToPython();
  _applySettingsToPython();
  _renderNodeList();
  _renderBanner();
  _drawFRFPlot();
  if (_activeTab === 'modeshape') _renderModePlot(true);

  document.getElementById('geom-msg').textContent = 'Applied';
  setTimeout(() => { document.getElementById('geom-msg').textContent = ''; }, 2500);
  _hideModal('geom-modal');
};

function _rebuildGeomTables() {
  _rebuildNodeTable();
  _rebuildEdgeTable();
}

function _rebuildNodeTable() {
  const tbody = document.getElementById('geom-node-tbody');
  tbody.innerHTML = '';
  _geomDraft.nodes.forEach((n, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><input type="text"   class="gn-label" data-i="${i}" value="${_esc(n.label)}" maxlength="20" oninput="geomPreviewUpdate()"></td>` +
      `<td><input type="number" class="gn-x"     data-i="${i}" value="${n.x}" step="any" oninput="geomPreviewUpdate()"></td>` +
      `<td><input type="number" class="gn-y"     data-i="${i}" value="${n.y}" step="any" oninput="geomPreviewUpdate()"></td>` +
      `<td><input type="number" class="gn-z"     data-i="${i}" value="${n.z}" step="any" oninput="geomPreviewUpdate()"></td>` +
      `<td><button class="del-btn" onclick="geomRemoveNode(${i})">✕</button></td>`;
    tbody.appendChild(tr);
  });
}

function _rebuildEdgeTable() {
  const tbody = document.getElementById('geom-edge-tbody');
  tbody.innerHTML = '';
  _geomDraft.edges.forEach((e, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><input type="number" class="ge-a" data-i="${i}" value="${e[0]}" min="0" step="1" oninput="geomPreviewUpdate()"></td>` +
      `<td><input type="number" class="ge-b" data-i="${i}" value="${e[1]}" min="0" step="1" oninput="geomPreviewUpdate()"></td>` +
      `<td><button class="del-btn" onclick="geomRemoveEdge(${i})">✕</button></td>`;
    tbody.appendChild(tr);
  });
}

function _readGeomDraft() {
  // Read node table
  const labels = document.querySelectorAll('.gn-label');
  const xs     = document.querySelectorAll('.gn-x');
  const ys     = document.querySelectorAll('.gn-y');
  const zs     = document.querySelectorAll('.gn-z');
  labels.forEach((el, i) => {
    if (_geomDraft.nodes[i]) {
      _geomDraft.nodes[i].label = el.value.trim() || String(i+1);
      _geomDraft.nodes[i].x    = parseFloat(xs[i]?.value) || 0;
      _geomDraft.nodes[i].y    = parseFloat(ys[i]?.value) || 0;
      _geomDraft.nodes[i].z    = parseFloat(zs[i]?.value) || 0;
    }
  });
  // Read edge table
  const as = document.querySelectorAll('.ge-a');
  const bs = document.querySelectorAll('.ge-b');
  as.forEach((el, i) => {
    if (_geomDraft.edges[i]) {
      _geomDraft.edges[i][0] = parseInt(el.value) || 0;
      _geomDraft.edges[i][1] = parseInt(bs[i]?.value) || 0;
    }
  });
}

window.geomAddNode = function() {
  const n = _geomDraft.nodes.length;
  _geomDraft.nodes.push({ id:n, label:String(n+1), x:n*0.25, y:0, z:0 });
  _rebuildNodeTable();
  _updateGeomPreview();
};

window.geomRemoveNode = function(i) {
  _readGeomDraft();
  _geomDraft.nodes.splice(i, 1);
  _geomDraft.nodes.forEach((n, idx) => { n.id = idx; });
  _geomDraft.edges = _geomDraft.edges
    .filter(([a, b]) => a !== i && b !== i)
    .map(([a, b]) => [a > i ? a-1 : a, b > i ? b-1 : b]);
  _rebuildGeomTables();
  _updateGeomPreview();
};

window.geomAddEdge = function() {
  _readGeomDraft();
  const n = _geomDraft.nodes.length;
  _geomDraft.edges.push([0, Math.max(0, n-1)]);
  _rebuildEdgeTable();
  _updateGeomPreview();
};

window.geomRemoveEdge = function(i) {
  _readGeomDraft();
  _geomDraft.edges.splice(i, 1);
  _rebuildEdgeTable();
  _updateGeomPreview();
};

window.geomAutoConnect = function() {
  _readGeomDraft();
  const n = _geomDraft.nodes.length;
  _geomDraft.edges = [];
  for (let i = 0; i < n - 1; i++) _geomDraft.edges.push([i, i+1]);
  _rebuildEdgeTable();
  _updateGeomPreview();
};

function _pushGeometryToPython() {
  if (!window.pySetGeometry) return;
  const coords = {};
  _geometry.nodes.forEach((n, i) => {
    coords[String(i)] = { x: n.x, y: n.y, z: n.z, label: n.label };
  });
  window.pySetGeometry(JSON.stringify(coords));
}

async function _saveGeometry() {
  if (!_studyHandle) return;
  try {
    await _writeFile(_studyHandle, 'geometry.json',
      JSON.stringify(_geometry, null, 2));
  } catch(_) {}
}

async function _loadGeometry() {
  if (!_studyHandle) return;
  try {
    const fh = await _studyHandle.getFileHandle('geometry.json');
    const f  = await fh.getFile();
    const g  = JSON.parse(await f.text());
    if (g && Array.isArray(g.nodes)) {
      _geometry = g;
      _pushGeometryToPython();
      _renderNodeList();
      _renderBanner();
    }
  } catch(_) {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// Data folder & study management
// ═══════════════════════════════════════════════════════════════════════════════

window.msSetDataFolder = async function() {
  try {
    const handle = await window.showDirectoryPicker({ mode:'readwrite' });
    await saveDataFolderHandle(handle);
    _rootDirHandle = handle;
    document.getElementById('ms-folder-name').textContent = handle.name;
    const { isNew } = await openObieAppSettings(handle);
    if (isNew) alert('This is a new Data Folder — a default settings folder was created.');
    _refreshOverlay();
  } catch(e) {
    if (e.name !== 'AbortError') alert('Could not open folder: ' + e.message);
  }
};

window.msSetStudy = function() {
  document.getElementById('study-inp').value = _studyName;
  _showModal('study-modal');
  setTimeout(() => document.getElementById('study-inp').focus(), 50);
};

window.msCloseStudy  = function() { _hideModal('study-modal'); };

window.msConfirmStudy = async function() {
  const name = document.getElementById('study-inp').value.trim();
  if (!name) return;
  if (!_rootDirHandle) { alert('Select a Data Folder first.'); return; }
  try {
    _studyName   = name;
    _studyHandle = await _rootDirHandle.getDirectoryHandle(name, { create:true });
    _rawHandle   = await _studyHandle.getDirectoryHandle('raw', { create:true });
    document.getElementById('ms-study-name-disp').textContent = name;
    document.getElementById('ms-study-banner').textContent   = name + ' ·';
    document.getElementById('study-modal-msg').textContent   = 'Set!';
    setTimeout(() => { document.getElementById('study-modal-msg').textContent = ''; _hideModal('study-modal'); }, 2500);
    await _loadGeometry();
    _saveGeometry();
  } catch(e) { alert('Could not create study folder: ' + e.message); }
};

function _refreshOverlay() {
  const overlay = document.getElementById('folder-overlay');
  if (!overlay) return;
  if (_rootDirHandle) {
    overlay.classList.add('hidden');
    document.getElementById('ms-folder-name').textContent = _rootDirHandle.name;
  } else {
    overlay.classList.remove('hidden');
  }
}

async function _writeFile(dirHandle, name, bytes) {
  try {
    const fh = await dirHandle.getFileHandle(name, { create:true });
    const ws = await fh.createWritable();
    await ws.write(bytes);
    await ws.close();
  } catch(e) { console.warn('writeFile failed:', name, e); }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Preferences modal
// ═══════════════════════════════════════════════════════════════════════════════

window.msPreferences = function() {
  _populateDeviceList();
  _showModal('prefs-modal');
};
window.msClosePrefs = function() { _hideModal('prefs-modal'); };

window.msSavePrefs = function() {
  const g = id => parseFloat(document.getElementById(id)?.value || 0);
  _applySettingsToPython();
  _S.xMin    = g('inp-frf-x-min');
  _S.xMax    = g('inp-frf-x-max');
  _S.yMin    = g('inp-frf-y-min');
  _S.yMax    = g('inp-frf-y-max');
  _S.yDbRange = g('inp-db-spread');
  _S.dbOffset = g('inp-db-offset');
  _lineWidth  = g('inp-line-width') || 0.5;
  _hamXRange  = [g('inp-ham-x-min'), g('inp-ham-x-max')];
  _micXRange  = [g('inp-mic-x-min'), g('inp-mic-x-max')];
  _fftXRange  = [g('inp-fft-x-min'), g('inp-fft-x-max')];
  document.getElementById('ms-y-db-range').value = _S.yDbRange;

  if (window.pySavePrefs) {
    window.pySavePrefs(
      g('inp-threshold'), g('inp-pre'), g('inp-post'), g('inp-ham-cut'), g('inp-mic-cut'),
      g('inp-taps'), g('inp-mic-cal'), g('inp-ham-cal'), g('inp-sample-rate'),
      document.getElementById('inp-swap-channels')?.checked || false,
      g('inp-db-spread'), g('inp-db-offset'), g('inp-line-width'),
      g('inp-frf-x-min'), g('inp-frf-x-max'), g('inp-frf-y-min'), g('inp-frf-y-max'),
      g('inp-ham-x-min'), g('inp-ham-x-max'), -1, 1,
      g('inp-mic-x-min'), g('inp-mic-x-max'), -1, 1,
      g('inp-fft-x-min'), g('inp-fft-x-max'), _fftYRange[0], _fftYRange[1],
      document.getElementById('prefs-device')?.value || ''
    );
  }

  _drawFRFPlot();
  document.getElementById('prefs-save-msg').textContent = 'Saved';
  setTimeout(() => { document.getElementById('prefs-save-msg').textContent = ''; }, 2500);
};

window.msResetPrefs = function() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('inp-threshold', 0.05); set('inp-pre', 0.01); set('inp-post', 0.30);
  set('inp-ham-cut', 0.30); set('inp-mic-cut', 0.30); set('inp-taps', 5);
  set('inp-mic-cal', 1.0); set('inp-ham-cal', 1.0); set('inp-sample-rate', 48000);
  set('inp-db-spread', 38); set('inp-db-offset', 0); set('inp-line-width', 0.5);
  set('inp-frf-x-min', 200); set('inp-frf-x-max', 7000);
  set('inp-frf-y-min', -10); set('inp-frf-y-max', 30);
  set('inp-ham-x-min', 0); set('inp-ham-x-max', 0.05);
  set('inp-mic-x-min', 0); set('inp-mic-x-max', 0.3);
  set('inp-fft-x-min', 200); set('inp-fft-x-max', 10000);
  const sw = document.getElementById('inp-swap-channels');
  if (sw) sw.checked = false;
};

async function _populateDeviceList() {
  const sel = document.getElementById('prefs-device');
  if (!sel) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs  = devices.filter(d => d.kind === 'audioinput');
    sel.innerHTML = '';
    inputs.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || d.deviceId;
      sel.appendChild(opt);
    });
  } catch(e) { sel.innerHTML = '<option>Permission needed</option>'; }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Sidebar resizer
// ═══════════════════════════════════════════════════════════════════════════════

(function() {
  const resizer = document.getElementById('ms-resizer');
  const sidebar = document.querySelector('.ms-sidebar');
  if (!resizer || !sidebar) return;
  let dragging = false, startX = 0, startW = 0;
  resizer.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(100, Math.min(350, startW + e.clientX - startX));
    sidebar.style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();


// ═══════════════════════════════════════════════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.code === 'Space' && document.getElementById('pos-complete-modal').classList.contains('active')) {
    e.preventDefault();
    msNextPosition();
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// Modal helpers
// ═══════════════════════════════════════════════════════════════════════════════

function _showModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}
function _hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

// Close modals on backdrop click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      // Don't close pos-complete via backdrop (must choose an action)
      if (overlay.id !== 'pos-complete-modal') overlay.classList.remove('active');
    }
  });
});

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ═══════════════════════════════════════════════════════════════════════════════
// Notes
// ═══════════════════════════════════════════════════════════════════════════════

const _NOTES_KEY = () => 'msModeNotes_' + (_studyName || 'default');

window.msNotes = async function() {
  const ta = document.getElementById('ms-notes-textarea');
  if (ta) {
    let text = localStorage.getItem(_NOTES_KEY()) || '';
    if (_studyHandle) {
      try {
        const fh = await _studyHandle.getFileHandle('notes.txt');
        text = await (await fh.getFile()).text();
      } catch(_) {}
    }
    ta.value = text;
  }
  _showModal('notes-modal');
};
window.msCloseNotes = function() { _hideModal('notes-modal'); };
window.msSaveNotes  = async function() {
  const ta = document.getElementById('ms-notes-textarea');
  const text = ta?.value || '';
  localStorage.setItem(_NOTES_KEY(), text);
  if (_studyHandle) {
    try { await _writeFile(_studyHandle, 'notes.txt', new TextEncoder().encode(text)); } catch(_) {}
  }
  const msg = document.getElementById('notes-save-msg');
  if (msg) { msg.textContent = 'Saved'; setTimeout(() => { msg.textContent = ''; }, 2500); }
};


// ═══════════════════════════════════════════════════════════════════════════════
// Templates
// ═══════════════════════════════════════════════════════════════════════════════

let _templates          = [];
let _selectedTpl        = -1;
let _tplsHandle         = null;
let _currentTemplateName = '';

function _setCurrentTemplate(name) {
  _currentTemplateName = name;
  const el = document.getElementById('ms-tpl-ind');
  if (el) el.textContent = name ? '📋 ' + name : '';
}

window.msTemplate = async function() {
  await _loadTemplateList();
  _showModal('template-modal');
};
window.msCloseTemplate = function() { _hideModal('template-modal'); };

async function _loadTemplateList() {
  _templates = [];
  const listEl = document.getElementById('ms-tpl-list');
  if (_rootDirHandle) {
    try {
      const { templatesHandle } = await openObieAppSettings(_rootDirHandle);
      _tplsHandle = templatesHandle;
      for await (const [name, fh] of templatesHandle.entries()) {
        if (!name.endsWith('.json')) continue;
        try {
          const f = await fh.getFile();
          const j = JSON.parse(await f.text());
          _templates.push({ name: name.replace('.json',''), data: j });
        } catch(_) {}
      }
    } catch(_) {}
  }
  _renderTemplateList(listEl);
}

function _renderTemplateList(listEl) {
  listEl.innerHTML = '';
  if (_templates.length === 0) {
    listEl.innerHTML = '<div style="font-size:11px;color:var(--muted)">No templates found.</div>';
    return;
  }
  _templates.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'tpl-item' + (_selectedTpl === i ? ' selected' : '');
    div.innerHTML = `<span class="tpl-name">${_esc(t.name)}</span><button class="tpl-del-btn" onclick="msDeleteTemplate(${i})">🗑</button>`;
    div.addEventListener('click', e => {
      if (e.target.classList.contains('tpl-del-btn')) return;
      _selectedTpl = i;
      _renderTemplateList(listEl);
    });
    listEl.appendChild(div);
  });
}

window.msDeleteTemplate = async function(i) {
  if (!_tplsHandle) return;
  const name = _templates[i]?.name;
  if (!name || !confirm(`Delete template "${name}"?`)) return;
  try { await _tplsHandle.removeEntry(name + '.json'); } catch(_) {}
  if (_selectedTpl === i) _selectedTpl = -1;
  await _loadTemplateList();
};

window.msBrowseTemplate = async function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      _templates.push({ name: file.name.replace('.json',''), data });
      _selectedTpl = _templates.length - 1;
      _renderTemplateList(document.getElementById('ms-tpl-list'));
    } catch(e) { alert('Could not read template: ' + e.message); }
  };
  input.click();
};

window.msApplyTemplate = function() {
  if (_selectedTpl < 0 || !_templates[_selectedTpl]) return;
  const d = _templates[_selectedTpl].data;
  const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
  set('inp-threshold',   d.threshold);
  set('inp-pre',         d.pre_trig_s);
  set('inp-post',        d.post_trig_s);
  set('inp-ham-cut',     d.ham_cut);
  set('inp-mic-cut',     d.mic_cut);
  set('inp-taps',        d.taps);
  set('inp-mic-cal',     d.mic_cal);
  set('inp-ham-cal',     d.ham_cal);
  set('inp-sample-rate', d.sample_rate);
  const sw = document.getElementById('inp-swap-channels');
  if (sw && d.swap_channels !== undefined) sw.checked = d.swap_channels;
  if (d.geometry && Array.isArray(d.geometry.nodes)) {
    const hasData = Object.keys(_frfCache).length > 0;
    if (hasData && d.geometry.nodes.length !== _geometry.nodes.length) {
      if (!confirm('Applying this template will change the geometry and clear existing measurements. Continue?')) {
        _applySettingsToPython(); _hideModal('template-modal'); return;
      }
      _frfCache = {}; _tapCache = {}; _histCache = {}; _complexFRFs = {};
      window.pyResetAll?.(); _clearFRFPlot(); _clearModePlot();
    }
    _geometry = d.geometry;
    _pushGeometryToPython();
    _renderNodeList(); _renderBanner();
  }
  _applySettingsToPython();
  _setCurrentTemplate(_templates[_selectedTpl].name);
  const msg = document.getElementById('tpl-save-msg');
  if (msg) { msg.textContent = 'Applied'; setTimeout(() => { msg.textContent = ''; _hideModal('template-modal'); }, 2500); }
};

window.msSaveAsTemplate = async function() {
  const name = prompt('Template name:', _studyName || 'New Template');
  if (!name) return;
  const g = id => parseFloat(document.getElementById(id)?.value || 0);
  const data = {
    threshold: g('inp-threshold'), pre_trig_s: g('inp-pre'), post_trig_s: g('inp-post'),
    ham_cut: g('inp-ham-cut'), mic_cut: g('inp-mic-cut'), taps: g('inp-taps'),
    mic_cal: g('inp-mic-cal'), ham_cal: g('inp-ham-cal'),
    sample_rate: g('inp-sample-rate'),
    swap_channels: document.getElementById('inp-swap-channels')?.checked || false,
    geometry: JSON.parse(JSON.stringify(_geometry)),
  };
  const json = JSON.stringify(data, null, 2);
  if (_tplsHandle) {
    try {
      await _writeFile(_tplsHandle, name + '.json', new TextEncoder().encode(json));
      const msg = document.getElementById('tpl-save-msg');
      if (msg) { msg.textContent = 'Saved to folder'; setTimeout(() => { msg.textContent = ''; }, 2500); }
      await _loadTemplateList();
      return;
    } catch(_) {}
  }
  // Fallback: download
  const blob = new Blob([json], { type: 'application/json' });
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name + '.json' }).click();
};


// ═══════════════════════════════════════════════════════════════════════════════
// LiveView
// ═══════════════════════════════════════════════════════════════════════════════

let _lvAudioCtx    = null;
let _lvMediaStream = null;
let _lvWorklet     = null;
let _lvSource      = null;
let _lvAnalyser    = null;
let _lvRunning     = false;
let _lvRafId       = null;
let _lvMode        = 'live';     // 'live' | 'trigger'
let _lvTrigCapture = null;       // { ham, mic, fftData } when triggered
let _lvTrigArmed   = true;
let _lvCooldown    = 0;
const _LV_COOLDOWN = 30;         // ~1.2 s at 25fps before re-arming
const _LV_BUF_LEN  = 8192;
let _lvBufHam      = new Float32Array(_LV_BUF_LEN);
let _lvBufMic      = new Float32Array(_LV_BUF_LEN);
let _lvWritePos    = 0;
let _lvSR          = 48000;

window.msLiveView = async function() {
  await _populateLVDeviceList();
  _showModal('lv-modal');
  // auto-start
  if (!_lvRunning) await _lvStart();
};

window.msCloseLV = function() {
  _lvStop();
  _hideModal('lv-modal');
};

window.lvSetMode = function(mode) {
  _lvMode = mode;
  _lvTrigCapture = null;
  _lvTrigArmed   = true;
  document.getElementById('lv-mode-live').classList.toggle('active', mode === 'live');
  document.getElementById('lv-mode-trigger').classList.toggle('active', mode === 'trigger');
  const st = document.getElementById('lv-status');
  if (st) st.textContent = mode === 'live' ? 'Live streaming…' : 'Armed — waiting for trigger…';
};

async function _populateLVDeviceList() {
  const sel = document.getElementById('lv-device-sel');
  if (!sel) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    sel.innerHTML = '';
    devs.filter(d => d.kind === 'audioinput').forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || d.deviceId;
      sel.appendChild(o);
    });
    const prefsDev = document.getElementById('prefs-device')?.value;
    if (prefsDev) sel.value = prefsDev;
  } catch(_) {}
}

window.lvToggleCapture = function() {
  if (_lvRunning) _lvStop(); else _lvStart();
};

window.lvRestartWithDevice = function() {
  if (_lvRunning) { _lvStop(); _lvStart(); }
};

async function _lvStart() {
  const sel   = document.getElementById('lv-device-sel');
  const devId = sel?.value;
  _lvSR = Number(document.getElementById('inp-sample-rate')?.value || 48000);
  try {
    const blob    = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const blobURL = URL.createObjectURL(blob);
    _lvAudioCtx = new AudioContext({ sampleRate: _lvSR });
    await _lvAudioCtx.audioWorklet.addModule(blobURL);
    URL.revokeObjectURL(blobURL);
    _lvMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: devId ? { exact: devId } : undefined,
               channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    _lvSource   = _lvAudioCtx.createMediaStreamSource(_lvMediaStream);
    _lvAnalyser = _lvAudioCtx.createAnalyser();
    _lvAnalyser.fftSize = 4096;
    _lvAnalyser.smoothingTimeConstant = 0.6;
    _lvWorklet  = new AudioWorkletNode(_lvAudioCtx, 'modal-capture',
      { numberOfInputs:1, numberOfOutputs:1, channelCount:2, channelCountMode:'explicit' });

    _lvWorklet.port.onmessage = ({ data }) => {
      const swap = document.getElementById('inp-swap-channels')?.checked;
      const H = swap ? data.r : data.l;
      const M = swap ? data.l : data.r;
      for (let i = 0; i < H.length; i++) {
        _lvBufHam[_lvWritePos % _LV_BUF_LEN] = H[i];
        _lvBufMic[_lvWritePos % _LV_BUF_LEN] = M[i];
        _lvWritePos++;
      }
      // Trigger detection
      if (_lvMode === 'trigger' && _lvTrigArmed) {
        const thr = parseFloat(document.getElementById('lv-inp-thr')?.value || 0.05);
        if (H.some(v => Math.abs(v) > thr)) {
          _lvTrigArmed = false;
          _lvCooldown  = _LV_COOLDOWN;
          // Snapshot ring buffer at trigger
          const preS  = Math.round(parseFloat(document.getElementById('lv-inp-pre')?.value || 0.01) * _lvSR);
          const postS = Math.round(parseFloat(document.getElementById('lv-inp-post')?.value || 0.20) * _lvSR);
          const winLen = Math.min(preS + postS, _LV_BUF_LEN);
          const ham = new Float32Array(winLen), mic = new Float32Array(winLen);
          const startIdx = _lvWritePos - H.length - preS;
          for (let i = 0; i < winLen; i++) {
            ham[i] = _lvBufHam[(startIdx + i + _LV_BUF_LEN * 4) % _LV_BUF_LEN];
            mic[i] = _lvBufMic[(startIdx + i + _LV_BUF_LEN * 4) % _LV_BUF_LEN];
          }
          const fftData = new Float32Array(_lvAnalyser.frequencyBinCount);
          _lvAnalyser.getFloatFrequencyData(fftData);
          _lvTrigCapture = { ham, mic, fftData };
        }
      }
    };

    _lvSource.connect(_lvWorklet);
    _lvSource.connect(_lvAnalyser);
    _lvWorklet.connect(_lvAudioCtx.destination);
    _lvRunning = true;
    document.getElementById('lv-start-btn').textContent = '⏹ Stop';
    const st = document.getElementById('lv-status');
    if (st) st.textContent = _lvMode === 'live' ? 'Live streaming…' : 'Armed — waiting for trigger…';
    _lvRender();
  } catch(e) {
    const st = document.getElementById('lv-status');
    if (st) st.textContent = 'Error: ' + e.message;
  }
}

function _lvStop() {
  _lvRunning = false;
  if (_lvRafId) { cancelAnimationFrame(_lvRafId); _lvRafId = null; }
  try { _lvWorklet?.disconnect(); _lvSource?.disconnect(); _lvAnalyser?.disconnect(); } catch(_) {}
  try { _lvMediaStream?.getTracks().forEach(t => t.stop()); } catch(_) {}
  try { _lvAudioCtx?.close(); } catch(_) {}
  _lvAudioCtx = _lvSource = _lvWorklet = _lvMediaStream = _lvAnalyser = null;
  const btn = document.getElementById('lv-start-btn');
  if (btn) btn.textContent = '▶ Start';
  const st = document.getElementById('lv-status');
  if (st) st.textContent = 'Press Start to begin';
}

let _lvLastFrame = 0;
function _lvRender(now) {
  if (!_lvRunning) return;
  _lvRafId = requestAnimationFrame(_lvRender);
  now = now || performance.now();
  if (now - _lvLastFrame < 40) return;  // 25fps cap
  _lvLastFrame = now;

  if (_lvCooldown > 0 && --_lvCooldown === 0) _lvTrigArmed = true;

  const thr = parseFloat(document.getElementById('lv-inp-thr')?.value || 0.05);

  if (_lvMode === 'trigger' && _lvTrigCapture) {
    // Show frozen triggered window
    _lvDrawWave('lv-hammer-canvas', _lvTrigCapture.ham, '#7c2bc8', thr);
    _lvDrawWave('lv-mic-canvas',    _lvTrigCapture.mic, '#1565c0', 0);
    _lvDrawFFTData('lv-fft-canvas', _lvTrigCapture.fftData);
    const st = document.getElementById('lv-status');
    if (st) st.textContent = _lvTrigArmed ? 'Armed — waiting for trigger…' : 'Triggered ✓';
  } else if (_lvMode === 'live' || !_lvTrigCapture) {
    // Scrolling live view
    const N = _LV_BUF_LEN, wp = _lvWritePos % N;
    const ham = new Float32Array(N), mic = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      ham[i] = _lvBufHam[(wp + i) % N];
      mic[i] = _lvBufMic[(wp + i) % N];
    }
    _lvDrawWave('lv-hammer-canvas', ham, '#7c2bc8', thr);
    _lvDrawWave('lv-mic-canvas',    mic, '#1565c0', 0);
    if (_lvAnalyser) _lvDrawFFTAnalyser('lv-fft-canvas');
  }

  // Peak meters (always live)
  let pkH = 0, pkM = 0;
  for (let i = 0; i < _LV_BUF_LEN; i++) {
    pkH = Math.max(pkH, Math.abs(_lvBufHam[i]));
    pkM = Math.max(pkM, Math.abs(_lvBufMic[i]));
  }
  document.getElementById('lv-level-h').textContent = pkH.toFixed(3) + ' V';
  document.getElementById('lv-level-m').textContent = pkM.toFixed(3) + ' V';
}

function _lvDrawWave(canvasId, data, color, thr) {
  const cv = document.getElementById(canvasId);
  if (!cv) return;
  const W = cv.offsetWidth, H = cv.offsetHeight;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
  if (thr > 0) {
    ctx.strokeStyle = 'rgba(180,0,0,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
    [H/2 - thr*H*0.48, H/2 + thr*H*0.48].forEach(y => {
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    });
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
  const step = W / data.length;
  for (let i = 0; i < data.length; i++) {
    const x = i * step, y = H/2 - data[i] * H * 0.48;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// FFT from AnalyserNode (live mode — log x-scale, dBFS y-scale)
function _lvDrawFFTAnalyser(canvasId) {
  const cv = document.getElementById(canvasId);
  if (!cv || !_lvAnalyser) return;
  const W = cv.offsetWidth, H = cv.offsetHeight;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const bins = _lvAnalyser.frequencyBinCount;
  const data = new Float32Array(bins);
  _lvAnalyser.getFloatFrequencyData(data);
  _lvDrawFFTData(canvasId, data, ctx, W, H);
}

// FFT from a pre-computed Float32Array of dBFS values (triggered mode)
function _lvDrawFFTData(canvasId, data, existingCtx, existingW, existingH) {
  const cv = document.getElementById(canvasId);
  if (!cv) return;
  const W = existingW || cv.offsetWidth, H = existingH || cv.offsetHeight;
  if (!existingCtx) {
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  }
  const ctx = existingCtx || cv.getContext('2d');
  if (!existingCtx) { ctx.clearRect(0,0,W,H); ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H); }
  ctx.strokeStyle = '#9c27b0'; ctx.lineWidth = 1.5; ctx.beginPath();
  const DB_MIN = -90, DB_MAX = -10;
  const bins = data.length;
  for (let i = 1; i < bins; i++) {
    const xf = Math.log(i / bins) / Math.log(1 / bins);  // log-scale x
    const x  = xf * W;
    const y  = H - ((Math.max(DB_MIN, Math.min(DB_MAX, data[i])) - DB_MIN) / (DB_MAX - DB_MIN)) * H;
    i === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}


// ═══════════════════════════════════════════════════════════════════════════════
// Startup: restore data folder handle
// ═══════════════════════════════════════════════════════════════════════════════

(async function _init() {
  try {
    const handle = await loadDataFolderHandle();
    if (handle) {
      const perm = await handle.queryPermission({ mode:'readwrite' });
      if (perm === 'granted') {
        _rootDirHandle = handle;
        document.getElementById('ms-folder-name').textContent = handle.name;
        _refreshOverlay();
      }
    }
  } catch(_) {}

  _renderNodeList();
  _renderBanner();
})();
