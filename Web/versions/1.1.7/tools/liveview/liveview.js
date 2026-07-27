// liveview.js — standalone LiveView tool.
//
// This is a relocated copy of Acquire's embedded LiveView dialog (acquire.js,
// "LiveView dialog" section). It is intentionally pure JS/canvas with no
// PyScript dependency, matching the precedent set by tools/template/
// (Stencil Builder) — see CLAUDE.md Rule 1: this tool does no FRF/TRF file
// I/O or canonical DSP, so there's nothing here that belongs in Python/.
//
// Settings (threshold / pre-trig / post-trig / device) are read from
// ObieAppSettings/acquire.json in the shared Data Folder, layered under
// whatever's in this browser's obieAcquire_prefs localStorage (so if Acquire
// has been used in this browser, its live settings take precedence). This
// tool never calls into a running Acquire tab directly — instead "Save as
// Default Settings" writes back to acquire.json on disk, which Acquire picks
// up the next time it loads or the user clicks its own "Reset to defaults".

let _rootDirHandle  = null;
let _settingsHandle = null;
let _diskPrefs      = {};

function _loadPrefs() {
  let local = {};
  try { local = JSON.parse(localStorage.getItem('obieAcquire_prefs') || '{}'); } catch (_) {}
  return { ..._diskPrefs, ...local };
}

// ── Data folder ─────────────────────────────────────────────────────────────
async function _applyDataFolder(dirHandle) {
  _rootDirHandle = dirHandle;
  const { settingsHandle, isNew } = await openObieAppSettings(dirHandle);
  _settingsHandle = settingsHandle;
  if (isNew) alert('This is a new Data Folder and I moved over the default settings folder.');

  try {
    const file = await (await _settingsHandle.getFileHandle('acquire.json')).getFile();
    _diskPrefs = JSON.parse(await file.text());
  } catch (_) {
    _diskPrefs = {};
  }

  const btn = document.getElementById('lv-folder-btn');
  if (btn) btn.textContent = '📁 ' + dirHandle.name;
  const nameEl = document.getElementById('lv-folder-name');
  if (nameEl) nameEl.textContent = dirHandle.name;

  _lvApplyPrefsToForm();
  await _lvEnumerateMics();
}

window.lvSetDataFolder = async function() {
  if (!window.showDirectoryPicker) { alert('Directory picker requires Chrome/Edge.'); return; }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e.name !== 'AbortError') alert('Folder error: ' + e.message);
    return;
  }
  try {
    await _applyDataFolder(dirHandle);
    await saveDataFolderHandle(dirHandle);
  } catch (e) {
    alert('Folder error: ' + e.message);
  }
};

window.lvSaveAsDefaultSettings = async function() {
  const st = document.getElementById('lv-save-msg');
  if (!_settingsHandle) {
    alert('Set a Data Folder first — default settings save to ObieAppSettings/acquire.json.');
    return;
  }
  const thr  = parseFloat(document.getElementById('lv-inp-thr')?.value);
  const pre  = parseFloat(document.getElementById('lv-inp-pre')?.value);
  const post = parseFloat(document.getElementById('lv-inp-post')?.value);
  const deviceId = document.getElementById('lv-mic-sel')?.value || '';
  if (isNaN(thr) || isNaN(pre) || isNaN(post)) return;

  _diskPrefs = { ..._diskPrefs, threshold: thr, pre_trig_s: pre, post_trig_s: post };
  if (deviceId) _diskPrefs.deviceId = deviceId;

  try {
    const fh = await _settingsHandle.getFileHandle('acquire.json', { create: true });
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(_diskPrefs, null, 2));
    await w.close();
    // Keep this browser's live Acquire session (if any) consistent immediately.
    try {
      const local = JSON.parse(localStorage.getItem('obieAcquire_prefs') || '{}');
      localStorage.setItem('obieAcquire_prefs', JSON.stringify({ ...local, ..._diskPrefs }));
    } catch (_) {}
    if (st) { st.textContent = '✓ Saved to Data Folder'; setTimeout(() => st.textContent = '', 2500); }
  } catch (e) {
    if (st) { st.textContent = '⚠ Save failed'; setTimeout(() => st.textContent = '', 2500); }
  }
};

window.lvHelp = function() { window.open('../../Docs/index.html', '_blank'); };

// ════════════════════════════════════════════════════════════════════════════
// LiveView engine — audio capture, FFT/H1, canvas rendering
// ════════════════════════════════════════════════════════════════════════════

const LV_WORKLET_SRC = `
class LVCaptureProcessor extends AudioWorkletProcessor {
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
registerProcessor('lv-capture', LVCaptureProcessor);
`;

let _lvAudioCtx    = null;
let _lvWorkletNode = null;
let _lvSource      = null;
let _lvStream      = null;
let _lvRunning     = false;
let _lvRafId       = null;
let _lvSr          = 44100;

const LV_RING_SECS = 4;
let _lvRingH  = new Float32Array(LV_RING_SECS * 44100);
let _lvRingM  = new Float32Array(LV_RING_SECS * 44100);
let _lvRingSz = LV_RING_SECS * 44100;
let _lvRingWr = 0;

function _lvReallocRing(sr) {
  _lvSr    = sr;
  _lvRingSz = LV_RING_SECS * sr;
  _lvRingH  = new Float32Array(_lvRingSz);
  _lvRingM  = new Float32Array(_lvRingSz);
  _lvRingWr = 0;
}
function _lvPushRing(L, R) {
  for (let i = 0; i < L.length; i++) {
    _lvRingH[_lvRingWr] = _lvSwap ? R[i] : L[i];
    _lvRingM[_lvRingWr] = _lvSwap ? L[i] : R[i];
    _lvRingWr = (_lvRingWr + 1) % _lvRingSz;
  }
}
function _lvRingTail(n) {
  n = Math.min(n, _lvRingSz);
  const H = new Float32Array(n), M = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const idx = (_lvRingWr - n + i + _lvRingSz) % _lvRingSz;
    H[i] = _lvRingH[idx]; M[i] = _lvRingM[idx];
  }
  return { H, M };
}
function _lvRingWindowAt(center, pre, post) {
  const n = pre + post;
  const H = new Float32Array(n), M = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const idx = (center - pre + i + _lvRingSz) % _lvRingSz;
    H[i] = _lvRingH[idx]; M[i] = _lvRingM[idx];
  }
  return { H, M };
}

let _lvMode = 'live';

window.lvSetMode = function(m) {
  _lvMode = m;
  document.getElementById('lv-mode-live')?.classList.toggle('active',    m === 'live');
  document.getElementById('lv-mode-trigger')?.classList.toggle('active', m === 'trigger');
  const t = document.getElementById('lv-frf-title');
  if (t) t.textContent = m === 'live' ? 'FRF (live estimate)' : 'FRF (H1 from triggered hits)';
  const cb = document.getElementById('lv-clear-btn');
  if (cb) cb.style.display = m === 'trigger' ? '' : 'none';
  const h = document.getElementById('lv-hits');
  if (h) h.textContent = '';
  if (m === 'trigger') _lvTrigState = 'armed';
  _lvFrfGxx = null; _lvFrfGxy_re = null; _lvFrfGxy_im = null; _lvFrfCount = 0;
  _lvCapturedH = null; _lvCapturedM = null; _lvCapturedFRF = null;
};

let _lvSwap         = false;
let _lvTrigState    = 'armed';
let _lvTrigRingPos  = 0;
let _lvPostLeft     = 0;
let _lvCapturedH    = null;
let _lvCapturedM    = null;
let _lvCapturedFRF  = null;
let _lvCapturedPreN = 0;
let _lvFrfGxx    = null;
let _lvFrfGxy_re = null;
let _lvFrfGxy_im = null;
let _lvFrfFreqs  = null;
let _lvFrfCount  = 0;

window.lvClearFRF = function() {
  _lvFrfGxx = null; _lvFrfGxy_re = null; _lvFrfGxy_im = null; _lvFrfCount = 0;
  _lvCapturedH = null; _lvCapturedM = null; _lvCapturedFRF = null;
  const h = document.getElementById('lv-hits'); if (h) h.textContent = '';
};

function _lvNextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function _lvFftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const theta = -2 * Math.PI / len;
    const wr = Math.cos(theta), wi = Math.sin(theta);
    for (let i = 0; i < n; i += len) {
      let ur = 1, ui = 0;
      for (let k = 0; k < (len >> 1); k++) {
        const ar = re[i+k], ai = im[i+k];
        const br = re[i+k+(len>>1)]*ur - im[i+k+(len>>1)]*ui;
        const bi = re[i+k+(len>>1)]*ui + im[i+k+(len>>1)]*ur;
        re[i+k]          = ar + br; im[i+k]          = ai + bi;
        re[i+k+(len>>1)] = ar - br; im[i+k+(len>>1)] = ai - bi;
        const ur2 = ur*wr - ui*wi; ui = ur*wi + ui*wr; ur = ur2;
      }
    }
  }
}
function _lvSpectrum(samples, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const len = Math.min(samples.length, N);
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1));
    re[i] = samples[i] * w;
  }
  _lvFftInPlace(re, im);
  return { re, im };
}
function _lvComputeH1(hamWin, micWin) {
  const N = _lvNextPow2(Math.max(hamWin.length, micWin.length));
  const H = _lvSpectrum(hamWin, N);
  const M = _lvSpectrum(micWin, N);
  const bins = N >> 1;
  const freqs = new Float32Array(bins), Gxx = new Float64Array(bins);
  const Gxy_re = new Float64Array(bins), Gxy_im = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    freqs[i]  = i * _lvSr / N;
    Gxx[i]    = H.re[i]*H.re[i] + H.im[i]*H.im[i];
    Gxy_re[i] = M.re[i]*H.re[i] + M.im[i]*H.im[i];
    Gxy_im[i] = M.im[i]*H.re[i] - M.re[i]*H.im[i];
  }
  return { freqs, Gxx, Gxy_re, Gxy_im };
}
function _lvH1ToDb(Gxx, Gxy_re, Gxy_im) {
  const mags = new Float32Array(Gxx.length);
  for (let i = 0; i < Gxx.length; i++) {
    const den = Gxx[i] + 1e-30;
    const hr = Gxy_re[i] / den, hi = Gxy_im[i] / den;
    mags[i] = 20 * Math.log10(Math.sqrt(hr*hr + hi*hi) + 1e-10);
  }
  return mags;
}

function _lvResizeCanvases() {
  ['lv-hammer-canvas', 'lv-mic-canvas', 'lv-frf-canvas'].forEach(id => {
    const c = document.getElementById(id);
    if (!c) return;
    c.width  = c.offsetWidth  * devicePixelRatio;
    c.height = c.offsetHeight * devicePixelRatio;
  });
}
window.addEventListener('resize', () => { if (document.getElementById('lv-hammer-canvas')) _lvResizeCanvases(); });

function _lvDrawTime(id, samples, color, thr, showThr) {
  const c = document.getElementById(id); if (!c) return;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  if (!samples || !samples.length) return;
  const n = samples.length;
  let pk = 0;
  for (let i = 0; i < n; i++) if (Math.abs(samples[i]) > pk) pk = Math.abs(samples[i]);
  pk = Math.max(pk * 1.2, thr * 1.5, 0.02);
  const yOf = v => h * (0.5 - v / (2 * pk));
  ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
  if (showThr && thr > 0) {
    ctx.setLineDash([4*devicePixelRatio, 4*devicePixelRatio]);
    ctx.strokeStyle = '#7c2bc8'; ctx.lineWidth = 1.5*devicePixelRatio;
    ctx.beginPath(); ctx.moveTo(0, yOf(thr));  ctx.lineTo(w, yOf(thr));  ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, yOf(-thr)); ctx.lineTo(w, yOf(-thr)); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.5*devicePixelRatio;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(n / w));
  for (let i = 0; i < n; i += step) {
    const x = w*i/n, y = yOf(samples[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#aaa'; ctx.font = `${9*devicePixelRatio}px sans-serif`; ctx.textBaseline = 'top';
  ctx.fillText(`pk ${(pk/1.2).toFixed(3)} V`, 4*devicePixelRatio, 3*devicePixelRatio);
}

function _lvDrawFRF(freqs, mags) {
  const c = document.getElementById('lv-frf-canvas'); if (!c) return;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  if (!freqs || !freqs.length) {
    ctx.fillStyle = '#ccc'; ctx.font = `${11*devicePixelRatio}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(_lvMode === 'trigger' ? 'Waiting for trigger…' : 'No data', w/2, h/2);
    ctx.textAlign = 'left'; return;
  }
  const fMin = 100, fMax = 12000;
  const fMinL = Math.log10(fMin), fMaxL = Math.log10(fMax);
  let yMax = -Infinity, yMin = Infinity;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] < fMin || freqs[i] > fMax || !isFinite(mags[i]) || mags[i] < -200) continue;
    if (mags[i] > yMax) yMax = mags[i];
    if (mags[i] < yMin) yMin = mags[i];
  }
  if (!isFinite(yMax)) { yMax = 20; yMin = -60; }
  yMax += 5; yMin = yMax - 60;
  const xOf = f => w * (Math.log10(Math.max(f, 0.1)) - fMinL) / (fMaxL - fMinL);
  const yOf = v => h * (1 - (v - yMin) / (yMax - yMin));
  ctx.strokeStyle = '#ececec'; ctx.lineWidth = 1;
  [100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => {
    const x = xOf(f); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  });
  ctx.strokeStyle = '#6a1b9a'; ctx.lineWidth = 1.8*devicePixelRatio;
  ctx.beginPath(); let started = false;
  for (let i = 1; i < freqs.length; i++) {
    if (freqs[i] < fMin || freqs[i] > fMax || !isFinite(mags[i]) || mags[i] < -200) { started = false; continue; }
    const x = xOf(freqs[i]), y = yOf(mags[i]);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = '#aaa'; ctx.font = `${9*devicePixelRatio}px sans-serif`;
  ctx.textBaseline = 'bottom';
  [100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => {
    ctx.fillText(f >= 1000 ? (f/1000)+'k' : f, xOf(f)+devicePixelRatio, h-devicePixelRatio);
  });
  ctx.textBaseline = 'top';
  ctx.fillText(`${yMax.toFixed(0)} dB`, 2*devicePixelRatio, 2*devicePixelRatio);
  ctx.fillText(`${yMin.toFixed(0)} dB`, 2*devicePixelRatio, h-12*devicePixelRatio);
}

function _lvSetSt(msg) { const el = document.getElementById('lv-status'); if (el) el.textContent = msg; }

async function _lvEnumerateMics() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const sel = document.getElementById('lv-mic-sel'); if (!sel) return;
    const savedId = _loadPrefs().deviceId || '';
    sel.innerHTML = '';
    const SKIP_LV = new Set(['default', 'communications']);
    devices.filter(d => d.kind === 'audioinput' && !SKIP_LV.has(d.deviceId)).forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Mic (${d.deviceId.slice(0,8)}…)`;
      if (d.deviceId === savedId) o.selected = true;
      sel.appendChild(o);
    });
  } catch(e) { _lvSetSt('Mic access denied: ' + e.message); }
}

function _lvApplyPrefsToForm() {
  const p = _loadPrefs();
  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  set('lv-inp-thr',  p.threshold   ?? 0.05);
  set('lv-inp-pre',  p.pre_trig_s  ?? 0.01);
  set('lv-inp-post', p.post_trig_s ?? 0.30);
}

window.lvToggleCapture = async function() {
  if (_lvRunning) { _lvStopCapture(); return; }
  const sel = document.getElementById('lv-mic-sel');
  const deviceId = sel?.value || '';
  try {
    _lvSetSt('Requesting microphone…');
    const prefs = _loadPrefs();
    _lvStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId:         deviceId ? { exact: deviceId } : undefined,
        channelCount:     { ideal: 2 },
        sampleRate:       { ideal: prefs.sample_rate ?? 48000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      }
    });
    _lvAudioCtx = new AudioContext();
    _lvSwap = prefs.swap_channels ?? false;
    _lvReallocRing(_lvAudioCtx.sampleRate);
    const blob = new Blob([LV_WORKLET_SRC], { type: 'application/javascript' });
    const blobURL = URL.createObjectURL(blob);
    await _lvAudioCtx.audioWorklet.addModule(blobURL);
    URL.revokeObjectURL(blobURL);
    _lvSource = _lvAudioCtx.createMediaStreamSource(_lvStream);
    _lvWorkletNode = new AudioWorkletNode(_lvAudioCtx, 'lv-capture', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 2, channelCountMode: 'explicit',
    });
    _lvWorkletNode.port.onmessage = ({ data }) => {
      _lvPushRing(data.l, data.r);
      if (_lvMode === 'trigger') _lvCheckTrigger(_lvSwap ? data.r : data.l);
    };
    _lvSource.connect(_lvWorkletNode);
    _lvRunning = true; _lvTrigState = 'armed';
    const btn = document.getElementById('lv-start-btn');
    if (btn) { btn.textContent = '■ Stop'; btn.classList.remove('accent'); btn.classList.add('stop'); }
    _lvSetSt(_lvMode === 'live' ? 'Running — live mode' : 'Armed — waiting for trigger…');
    _lvLoop();
  } catch(e) { _lvSetSt('Error: ' + e.message); }
};

function _lvStopCapture() {
  _lvRunning = false;
  if (_lvRafId) { cancelAnimationFrame(_lvRafId); _lvRafId = null; }
  if (_lvWorkletNode) { _lvWorkletNode.disconnect(); _lvWorkletNode = null; }
  if (_lvSource)      { _lvSource.disconnect();      _lvSource = null; }
  if (_lvStream)      { _lvStream.getTracks().forEach(t => t.stop()); _lvStream = null; }
  if (_lvAudioCtx)    { _lvAudioCtx.close(); _lvAudioCtx = null; }
  const btn = document.getElementById('lv-start-btn');
  if (btn) { btn.textContent = '▶ Start'; btn.classList.remove('stop'); btn.classList.add('accent'); }
  _lvSetSt('Stopped');
}

// Called when the user picks a different device while running — restart on the new device.
window.lvRestartWithDevice = async function() {
  const wasRunning = _lvRunning;
  if (wasRunning) {
    _lvStopCapture();
    await new Promise(r => setTimeout(r, 120));  // let the old context fully close
    lvToggleCapture();
  }
};

function _lvCheckTrigger(hammerBatch) {
  const thr = parseFloat(document.getElementById('lv-inp-thr')?.value) || 0.05;
  if (_lvTrigState === 'armed') {
    for (let i = 0; i < hammerBatch.length; i++) {
      if (Math.abs(hammerBatch[i]) > thr) {
        _lvTrigRingPos = (_lvRingWr - hammerBatch.length + i + _lvRingSz) % _lvRingSz;
        const postS = parseFloat(document.getElementById('lv-inp-post')?.value) || 0.30;
        _lvPostLeft = Math.ceil(postS * _lvSr) - (hammerBatch.length - i - 1);
        _lvTrigState = _lvPostLeft <= 0 ? 'capture_now' : 'triggered';
        if (_lvTrigState === 'capture_now') _lvDoCapture();
        break;
      }
    }
  } else if (_lvTrigState === 'triggered') {
    _lvPostLeft -= hammerBatch.length;
    if (_lvPostLeft <= 0) _lvDoCapture();
  }
}

function _lvDoCapture() {
  _lvTrigState = 'holding';
  const preS  = parseFloat(document.getElementById('lv-inp-pre')?.value)  || 0.01;
  const postS = parseFloat(document.getElementById('lv-inp-post')?.value) || 0.30;
  const preN  = Math.ceil(preS * _lvSr), postN = Math.ceil(postS * _lvSr);
  const { H, M } = _lvRingWindowAt(_lvTrigRingPos, preN, postN);
  _lvCapturedH = H; _lvCapturedM = M; _lvCapturedPreN = preN;
  const result = _lvComputeH1(H, M);
  if (!_lvFrfGxx) {
    _lvFrfGxx    = new Float64Array(result.Gxx);
    _lvFrfGxy_re = new Float64Array(result.Gxy_re);
    _lvFrfGxy_im = new Float64Array(result.Gxy_im);
    _lvFrfFreqs  = result.freqs;
  } else {
    const bins = Math.min(_lvFrfGxx.length, result.Gxx.length);
    for (let i = 0; i < bins; i++) {
      _lvFrfGxx[i]    += result.Gxx[i];
      _lvFrfGxy_re[i] += result.Gxy_re[i];
      _lvFrfGxy_im[i] += result.Gxy_im[i];
    }
  }
  _lvFrfCount++;
  _lvCapturedFRF = { freqs: _lvFrfFreqs, mags: _lvH1ToDb(_lvFrfGxx, _lvFrfGxy_re, _lvFrfGxy_im) };
  const h = document.getElementById('lv-hits');
  if (h) h.textContent = `${_lvFrfCount} hit${_lvFrfCount > 1 ? 's' : ''} averaged`;
  _lvSetSt(`Hit ${_lvFrfCount} captured — re-arming…`);
  setTimeout(() => { if (_lvRunning) { _lvTrigState = 'armed'; _lvSetSt('Armed — waiting for trigger…'); } }, 200);
}

let _lvLiveFrameCount = 0;
let _lvLiveFRF = null;

function _lvUpdateLiveFRF() {
  const postS = parseFloat(document.getElementById('lv-inp-post')?.value) || 0.30;
  const nAvg  = parseInt(document.getElementById('lv-num-avg')?.value) || 4;
  const { H, M } = _lvRingTail(Math.ceil(postS * _lvSr));
  const result    = _lvComputeH1(H, M);
  const mags      = _lvH1ToDb(result.Gxx, result.Gxy_re, result.Gxy_im);
  if (!_lvLiveFRF || _lvLiveFRF.freqs.length !== result.freqs.length) {
    _lvLiveFRF = { freqs: result.freqs, mags: new Float32Array(mags) };
  } else {
    const a = 1 / nAvg;
    for (let i = 0; i < mags.length; i++)
      _lvLiveFRF.mags[i] = _lvLiveFRF.mags[i] * (1 - a) + mags[i] * a;
  }
}

function _lvLoop() {
  if (!_lvRunning) return;
  _lvRafId = requestAnimationFrame(_lvLoop);
  _lvLiveFrameCount++;
  const thr = parseFloat(document.getElementById('lv-inp-thr')?.value) || 0.05;
  if (_lvMode === 'live') {
    const dispN = Math.ceil((parseFloat(document.getElementById('lv-inp-post')?.value) || 0.3) * _lvSr);
    const { H, M } = _lvRingTail(dispN);
    const pkH = H.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const pkM = M.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const lhEl = document.getElementById('lv-level-h');
    const lmEl = document.getElementById('lv-level-m');
    if (lhEl) lhEl.textContent = pkH > 1e-6 ? (20*Math.log10(pkH)).toFixed(1)+' dB' : '–';
    if (lmEl) lmEl.textContent = pkM > 1e-6 ? (20*Math.log10(pkM)).toFixed(1)+' dB' : '–';
    _lvDrawTime('lv-hammer-canvas', H, '#c62828', thr, true);
    _lvDrawTime('lv-mic-canvas',    M, '#1565c0', thr, false);
    if (_lvLiveFrameCount % 6 === 0) _lvUpdateLiveFRF();
    if (_lvLiveFRF) _lvDrawFRF(_lvLiveFRF.freqs, _lvLiveFRF.mags);
  } else {
    if (_lvCapturedH) {
      const pkH = _lvCapturedH.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      const pkM = _lvCapturedM.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      const lhEl = document.getElementById('lv-level-h');
      const lmEl = document.getElementById('lv-level-m');
      if (lhEl) lhEl.textContent = pkH > 1e-6 ? (20*Math.log10(pkH)).toFixed(1)+' dB' : '–';
      if (lmEl) lmEl.textContent = pkM > 1e-6 ? (20*Math.log10(pkM)).toFixed(1)+' dB' : '–';
      _lvDrawTime('lv-hammer-canvas', _lvCapturedH, '#c62828', thr, true);
      _lvDrawTime('lv-mic-canvas',    _lvCapturedM, '#1565c0', thr, false);
      if (_lvCapturedFRF) _lvDrawFRF(_lvCapturedFRF.freqs, _lvCapturedFRF.mags);
    } else {
      const { H, M } = _lvRingTail(Math.ceil(0.1 * _lvSr));
      _lvDrawTime('lv-hammer-canvas', H, '#c62828', thr, true);
      _lvDrawTime('lv-mic-canvas',    M, '#1565c0', thr, false);
      _lvDrawFRF(null, null);
    }
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
(async function _init() {
  _lvResizeCanvases();

  const storedName = localStorage.getItem('obieDataFolderName');
  const handle = await loadDataFolderHandle().catch(() => null);
  if (handle) {
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await _applyDataFolder(handle);
        return;
      }
    } catch (_) {}
    const nameEl = document.getElementById('lv-folder-name');
    if (nameEl && storedName) nameEl.textContent = `"${storedName}" needs permission — click 📁 Data Folder`;
  }
  // No folder yet (or permission not granted) — still let the mic list populate
  // from localStorage-only prefs so the tool is usable stand-alone.
  _lvApplyPrefsToForm();
  await _lvEnumerateMics();
})();
