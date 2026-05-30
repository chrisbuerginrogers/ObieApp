/* ─────────────────────────────────────────────────────────────────────
 * explore.js  —  Explore FRF tool
 *
 * Requires (loaded before this file):
 *   plotly-theme.js   — cssVar(), pcfg
 *   audio.js          — AudioPlayer
 * ───────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── Colour palettes ────────────────────────────────────────────────────
  const PALETTES = {
    default:  ['#ff6f00','#2196f3','#4caf50','#e91e63','#9c27b0','#00bcd4','#ff5722','#8bc34a','#ffc107','#607d8b'],
    warm:     ['#b71c1c','#c62828','#d32f2f','#e64a19','#f57c00','#ff8f00','#f9a825','#f57f17'],
    cool:     ['#0d47a1','#1565c0','#0277bd','#00838f','#006064','#1b5e20','#33691e','#827717'],
    contrast: ['#000000','#e53935','#1e88e5','#43a047','#fb8c00','#8e24aa','#00acc1','#6d4c41'],
  };
  const BAND_COLORS = ['#e74c3c','#e67e22','#2ecc71','#3498db','#9b59b6','#1abc9c','#f39c12'];

  // Band presets — loaded from ObieAppSettings/bands/ when a data folder is set.
  // Empty until a folder is selected; the dropdown shows only "No bands" + "Custom…".
  let _dynamicBandPresets = {};  // key → { label, bands: [{label,f_lo,f_hi}] }

  const INTERPRET_REGIONS = [
    {label:'A0',               f_lo:264,  f_hi:290,  color:'#e74c3c'},
    {label:'CBR',              f_lo:380,  f_hi:420,  color:'#e67e22'},
    {label:'B1-',              f_lo:393,  f_hi:470,  color:'#f1c40f'},
    {label:'B1+',              f_lo:473,  f_hi:593,  color:'#2ecc71'},
    {label:'Transition Hill',  f_lo:800,  f_hi:1300, color:'#3498db'},
    {label:'Bridge Hill',      f_lo:1750, f_hi:3000, color:'#9b59b6'},
    {label:'Upper Hill',       f_lo:3000, f_hi:7000, color:'#e91e63'},
  ];
  const TYPICAL_RANGES = [
    {mode:'A0',               range:'264–290 Hz',   avg:'276 Hz'},
    {mode:'CBR',              range:'380–420 Hz',   avg:'400 Hz'},
    {mode:'B1-',              range:'393–470 Hz',   avg:'444 Hz'},
    {mode:'B1+',              range:'473–593 Hz',   avg:'541 Hz'},
    {mode:'Transition Hill',  range:'800–1300 Hz',  avg:''},
    {mode:'Bridge Hill',      range:'1750–3000 Hz', avg:''},
    {mode:'Upper Hill',       range:'3000–7000 Hz', avg:''},
  ];
  const STRING_MODES = [
    {label:'G0', freq:196}, {label:'D0', freq:294},
    {label:'A0', freq:440}, {label:'E0', freq:659},
  ];

  // ── State ──────────────────────────────────────────────────────────────
  let _datasets  = [];
  let _undoStack = [];
  let _nextId    = 0;
  let _palette   = PALETTES.default;
  let _templates = [];
  let _dataDir              = null;  // FileSystemDirectoryHandle
  let _exploreSettingsHandle = null;  // ObieAppSettings/ dir
  let _bandsHandle          = null;  // ObieAppSettings/bands/ dir
  let _dirFiles  = [];     // [{name, ext, path, handle}] — scanned from data folder
  let _searchResults  = []; // current filtered list
  let _pendingPaths   = {}; // filename → full relative path, populated just before pyExploreLoadFile
  let _lists     = [];
  let _customBands = null;

  const _S = {
    xLog: true, xMin: 200, xMax: 7000,
    yLog: false, yMin: null, yMax: null,
    yDbRange: 38,
    smoothing: 0,
    normalize: false,     // legacy — kept so saved prefs still load
    normMode: 'as_measured',  // 'as_measured' | 'normalize' | 'avg_range'
    normFLo: 200, normFHi: 7000,
    bandPreset: '',
    bandShading: true,
    lineWidth: 1.0,
  };

  // ── Helpers ────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── IndexedDB wrapper (stores FileSystemDirectoryHandle across reloads) ─
  const _IDB = (() => {
    let _db = null;
    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise((res, rej) => {
        const req = indexedDB.open('obieExplore', 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
        req.onsuccess  = e => { _db = e.target.result; res(_db); };
        req.onerror    = e => rej(e.target.error);
      });
    }
    return {
      async put(key, val) {
        const db = await open();
        return new Promise((res, rej) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(val, key);
          tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
        });
      },
      async get(key) {
        const db = await open();
        return new Promise((res, rej) => {
          const tx = db.transaction('kv', 'readonly');
          const req = tx.objectStore('kv').get(key);
          req.onsuccess = () => res(req.result ?? null);
          req.onerror   = e => rej(e.target.error);
        });
      },
    };
  })();

  // ── Undo ───────────────────────────────────────────────────────────────
  function _saveUndo() {
    _undoStack.push(_datasets.map(d => ({...d, freqs:[...d.freqs], mags:[...d.mags]})));
    if (_undoStack.length > 20) _undoStack.shift();
    _syncUndoBtn();
  }
  function _syncUndoBtn() {
    const b = $('undo-btn'); if (b) b.disabled = !_undoStack.length;
  }

  // ── Smoothing (binary-search, O(n log n)) ─────────────────────────────
  function _smooth(freqs, mags, semitones) {
    if (!semitones) return mags;
    const ratio = Math.pow(2, semitones / 12);
    const n = freqs.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const fLo = freqs[i] / ratio, fHi = freqs[i] * ratio;
      let lo = 0, hi = n;
      while (lo < hi) { const m = (lo+hi)>>1; freqs[m] < fLo ? lo=m+1 : hi=m; }
      const s = lo; lo = 0; hi = n;
      while (lo < hi) { const m = (lo+hi)>>1; freqs[m] <= fHi ? lo=m+1 : hi=m; }
      const e = lo;
      let sum = 0; for (let j = s; j < e; j++) sum += mags[j];
      out[i] = e > s ? sum / (e - s) : mags[i];
    }
    return out;
  }

  // ── Normalize (shift max to 0 dB) ─────────────────────────────────────
  function _norm(mags) {
    let maxV = -Infinity;
    for (let i = 0; i < mags.length; i++) { if (isFinite(mags[i]) && mags[i] > maxV) maxV = mags[i]; }
    if (!isFinite(maxV)) return mags;
    return mags.map(v => v - maxV);
  }

  function _normByAvg(freqs, mags, fLo, fHi) {
    let sum = 0, n = 0;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= fLo && freqs[i] <= fHi && isFinite(mags[i])) { sum += mags[i]; n++; }
    }
    if (!n) return mags;
    const avg = sum / n;
    return mags.map(v => v - avg);
  }

  function _applyNorm(freqs, mags) {
    if (_S.normMode === 'normalize') return _norm(mags);
    if (_S.normMode === 'avg_range') return _normByAvg(freqs, mags, _S.normFLo, _S.normFHi);
    return mags;
  }

  // ── Band computation ───────────────────────────────────────────────────
  function _computeBands(freqs, mags, bands) {
    return bands.map(b => {
      const pts = freqs.reduce((acc, f, i) => {
        if (f >= b.f_lo && f <= b.f_hi && isFinite(mags[i])) acc.push([f, mags[i]]);
        return acc;
      }, []);
      if (!pts.length) return {...b, avg_db: 0, centroid: (b.f_lo + b.f_hi) / 2};
      const avg = pts.reduce((s, [,m]) => s + m, 0) / pts.length;
      let wsum = 0, wtot = 0;
      pts.forEach(([f, m]) => { const w = Math.pow(10, m / 20); wsum += f * w; wtot += w; });
      return {...b, avg_db: avg, centroid: wtot > 0 ? wsum / wtot : (b.f_lo + b.f_hi) / 2};
    });
  }

  // ── Band loading from ObieAppSettings/bands/ ─────────────────────────
  async function _loadBandsFromFolder(dir) {
    _dynamicBandPresets = {};
    try {
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== 'file' || !name.toLowerCase().endsWith('.txt')) continue;
        try {
          const text  = await (await h.getFile()).text();
          // Strip _filter.txt, _filter, or plain .txt — whichever applies
          const label = name
            .replace(/_filter\.txt$/i, '')
            .replace(/_filter$/i,      '')
            .replace(/\.txt$/i,        '')
            .replace(/\s+/g, ' ')
            .trim();
          // Parse tab-separated edge values (one line)
          const edges = text.trim().split(/\t/).map(s => parseFloat(s.trim())).filter(isFinite);
          if (edges.length < 2) continue;
          const bands = [];
          for (let i = 0; i < edges.length - 1; i++)
            bands.push({ label: `${Math.round(edges[i])}–${Math.round(edges[i+1])}`,
                         f_lo: edges[i], f_hi: edges[i+1] });
          _dynamicBandPresets[label] = { label, bands };
        } catch(_) {}
      }
    } catch(_) {}
    _populateBandSel();
  }

  function _shortBandLabel(full) {
    const cut = full.indexOf('(');
    const s = (cut > 0 ? full.slice(0, cut) : full).trim();
    return s.length > 12 ? s.slice(0, 11) + '…' : s;
  }

  function _populateBandSel() {
    const sel = $('band-sel'); if (!sel) return;
    const cur = _S.bandPreset;

    sel.innerHTML = '<option value="">No bands</option>';
    Object.keys(_dynamicBandPresets).sort().forEach(k => {
      const o = document.createElement('option');
      const full = _dynamicBandPresets[k].label;
      o.value = k;
      o.dataset.full = full;
      o.textContent = _shortBandLabel(full);
      sel.appendChild(o);
    });
    const oCustom = document.createElement('option');
    oCustom.value = 'custom'; oCustom.textContent = 'Custom…';
    sel.appendChild(oCustom);

    sel.value = (cur === 'custom' || _dynamicBandPresets[cur]) ? cur : '';
    if (sel.value !== cur) _S.bandPreset = sel.value;

    // Attach expand/collapse behaviour once per element
    if (!sel.dataset.bandEventsAttached) {
      sel.dataset.bandEventsAttached = '1';
      const showFull  = () => Array.from(sel.options).forEach(o => {
        if (o.dataset.full) o.textContent = o.dataset.full;
      });
      const showShort = () => Array.from(sel.options).forEach(o => {
        if (o.dataset.full) o.textContent = _shortBandLabel(o.dataset.full);
      });
      sel.addEventListener('mousedown', showFull);
      sel.addEventListener('keydown',   showFull);
      sel.addEventListener('blur',      showShort);
      sel.addEventListener('change',    showShort);
    }
  }

  // ── Render main plot ──────────────────────────────────────────────────
  function render() {
    const plotTraces = [];
    const bandShapes = [], bandTraces = [];

    _datasets.filter(d => d.visible).forEach(d => {
      let mags = _smooth(d.freqs, d.mags, _S.smoothing);
      mags = _applyNorm(d.freqs, mags);
      plotTraces.push({
        x: d.freqs, y: mags, type:'scatter', mode:'lines',
        name: d.name, line:{color:d.color, width:_S.lineWidth}, showlegend:false,
      });
    });
    if (!plotTraces.length)
      plotTraces.push({x:[], y:[], type:'scatter', mode:'lines', showlegend:false});

    // Bands
    const activeBands = _S.bandPreset === 'custom' && _customBands
      ? _customBands
      : (_S.bandPreset && _dynamicBandPresets[_S.bandPreset])
        ? _dynamicBandPresets[_S.bandPreset].bands
        : null;

    if (activeBands && plotTraces[0].x.length > 0) {
      const ref = plotTraces[0];
      const bd  = _computeBands(ref.x, ref.y, activeBands);
      window._exploreLastBandData = bd;
      bd.forEach((b, i) => {
        const c = BAND_COLORS[i % BAND_COLORS.length];
        if (_S.bandShading)
          bandShapes.push({type:'rect', xref:'x', yref:'paper', x0:b.f_lo, x1:b.f_hi, y0:0, y1:1, fillcolor:c, opacity:0.1, line:{width:0}});
        bandTraces.push({x:[b.f_lo,b.f_hi], y:[b.avg_db,b.avg_db], type:'scatter', mode:'lines', line:{color:c,width:2.5}, showlegend:false, hovertemplate:`<b>${_esc(b.label)}</b><br>Avg: ${b.avg_db.toFixed(1)} dB<extra></extra>`});
      });
      _renderBandTable(bd);
    } else {
      window._exploreLastBandData = null;
      _renderBandTable(null);
    }

    // Y range — avoid Math.max(...largeArray) which overflows the call stack
    let yRange;
    if (_S.yMin != null && _S.yMax != null) {
      yRange = [_S.yMin, _S.yMax];
    } else {
      let maxY = -Infinity;
      for (const t of plotTraces) { for (const v of t.y) { if (isFinite(v) && v > maxY) maxY = v; } }
      if (isFinite(maxY)) yRange = [maxY - _S.yDbRange, maxY + 2];
    }

    const border = cssVar('--border'), text = cssVar('--text');
    const xRange = (_S.xMin != null && _S.xMax != null)
      ? (_S.xLog ? [Math.log10(Math.max(_S.xMin,1)), Math.log10(_S.xMax)] : [_S.xMin, _S.xMax])
      : undefined;

    const layout = {
      paper_bgcolor:'#ffffff', plot_bgcolor:'#ffffff',
      font:{color:text, family:'inherit', size:12},
      margin:{l:65, r:16, t:12, b:50},
      showlegend:false, autosize:true,
      xaxis:{title:'Frequency (Hz)', type:_S.xLog?'log':'linear', range:xRange, gridcolor:border, zerolinecolor:border, linecolor:border},
      yaxis:{title:'Magnitude (dB)', type:_S.yLog?'log':'linear', range:yRange, gridcolor:border, zerolinecolor:border, linecolor:border},
      shapes: bandShapes,
    };

    Plotly.react('explore-plot', [...plotTraces, ...bandTraces], layout,
      {responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['sendDataToCloud'],
       toImageButtonOptions:{format:'png', scale:2, filename:'explore-frf'}});
  }

  // ── Band table ─────────────────────────────────────────────────────────
  function _renderBandTable(bd) {
    const el = $('band-table'); if (!el) return;
    if (!bd || !bd.length) { el.innerHTML = '<span class="muted-txt">Select a band preset</span>'; return; }
    el.innerHTML = '<table class="band-tbl"><thead><tr><th>Band</th><th>Avg dB</th><th>Centroid</th></tr></thead><tbody>'
      + bd.map((b, i) => {
        const c = BAND_COLORS[i % BAND_COLORS.length];
        return `<tr><td><span class="band-dot" style="background:${c}"></span>${_esc(b.label)}</td><td>${b.avg_db.toFixed(1)}</td><td>${b.centroid.toFixed(0)} Hz</td></tr>`;
      }).join('') + '</tbody></table>';
  }

  // ── Dataset list ───────────────────────────────────────────────────────
  function _renderList() {
    const box = $('dataset-list'); if (!box) return;
    if (!_datasets.length) {
      box.innerHTML = '<div class="ds-empty">Drop FRF files here or use Browse / Search</div>';
      return;
    }
    box.innerHTML = _datasets.map(d =>
      `<div class="ds-row${d.visible?'':' ds-hidden'}" data-id="${d.id}" title="${_esc(d.path || d.name)}">
        <input type="checkbox" class="ds-vis" data-id="${d.id}"${d.visible?' checked':''}>
        <span class="ds-swatch" data-id="${d.id}" style="background:${d.color}" title="Change colour"></span>
        <span class="ds-label">${_esc(d.name)}</span>
        <button class="ds-play-btn" data-id="${d.id}" title="Convolve and play">▶</button>
      </div>`
    ).join('');

    box.querySelectorAll('.ds-vis').forEach(cb => cb.addEventListener('change', e => {
      const d = _datasets.find(x => x.id === +e.target.dataset.id);
      if (d) { d.visible = e.target.checked; _renderList(); render(); }
    }));
    box.querySelectorAll('.ds-swatch').forEach(sw => sw.addEventListener('click', e => {
      const d = _datasets.find(x => x.id === +e.target.dataset.id); if (!d) return;
      const inp = document.createElement('input'); inp.type='color'; inp.value=d.color;
      inp.addEventListener('input', ev => { d.color=ev.target.value; _renderList(); render(); });
      inp.click();
    }));
    box.querySelectorAll('.ds-play-btn').forEach(btn => btn.addEventListener('click', e => {
      _playDataset(+e.target.dataset.id);
    }));

    // Hover: thicken the corresponding Plotly trace and show path tooltip
    box.querySelectorAll('.ds-row').forEach(row => {
      const id = +row.dataset.id;
      row.addEventListener('mouseenter', () => {
        const vis = _datasets.filter(d => d.visible);
        const idx = vis.findIndex(d => d.id === id);
        if (idx >= 0) Plotly.restyle('explore-plot', {'line.width': _S.lineWidth * 3}, [idx]);
      });
      row.addEventListener('mouseleave', () => {
        const vis = _datasets.filter(d => d.visible);
        const idx = vis.findIndex(d => d.id === id);
        if (idx >= 0) Plotly.restyle('explore-plot', {'line.width': _S.lineWidth}, [idx]);
      });
    });
  }

  // ── Play dataset ───────────────────────────────────────────────────────
  function _playDataset(id) {
    const d = _datasets.find(x => x.id === id); if (!d) return;
    if (!window.pyExploreConvolve) { alert('Python not ready — wait a moment.'); return; }
    const st = $('explore-status');
    if (st) st.textContent = `Convolving ${d.name}…`;
    window.pyExploreConvolve(new Float64Array(d.freqs), new Float64Array(d.mags));
  }

  window.onExploreConvolveResult = function(samplesArr, sr) {
    const samples = new Float32Array(samplesArr);
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, samples.length, +sr);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start();
    src.onended = () => ctx.close();
    const st = $('explore-status');
    if (st) { st.textContent = 'Playing…'; src.onended = () => { ctx.close(); st.textContent=''; }; }
  };
  window.onExploreConvolveError = function(msg) {
    const st = $('explore-status');
    if (st) { st.textContent = 'Error: ' + msg; setTimeout(() => st.textContent='', 5000); }
  };

  // ── Dataset ops ────────────────────────────────────────────────────────
  window.expSeeAll   = () => { _saveUndo(); _datasets.forEach(d=>d.visible=true);  _renderList(); render(); };
  window.expSeeNone  = () => { _saveUndo(); _datasets.forEach(d=>d.visible=false); _renderList(); render(); };
  window.expReduce   = () => { _saveUndo(); _datasets=_datasets.filter(d=>d.visible); _renderList(); render(); };
  window.expClearAll = () => { _saveUndo(); _datasets=[]; _renderList(); render(); };
  window.expUndo     = () => {
    if (!_undoStack.length) return;
    _datasets = _undoStack.pop(); _syncUndoBtn(); _renderList(); render();
  };

  // ── Toolbar: New Test ─────────────────────────────────────────────────
  window.expNewTest = function(e) {
    e.stopPropagation();
    const m = $('new-test-menu'); if (!m) return;
    m.classList.toggle('open');
    document.body.addEventListener('click', () => m.classList.remove('open'), {once:true});
  };
  window.expPickTemplate = function(idx) {
    const t = _templates[idx]; if (!t) return;
    alert(`You picked template: ${t.name}\n\n${t.description}`);
    if (t.settings) {
      const s = t.settings;
      if (s.x_min  != null) _S.xMin     = s.x_min;
      if (s.x_max  != null) _S.xMax     = s.x_max;
      if (s.x_log  != null) _S.xLog     = s.x_log;
      if (s.y_log  != null) _S.yLog     = s.y_log;
      if (s.y_db_range != null) _S.yDbRange = s.y_db_range;
      if (s.smoothing   != null) _S.smoothing   = s.smoothing;
      if (s.normalize   != null) _S.normalize   = s.normalize;
      if (s.normMode    != null) _S.normMode    = s.normMode;
      if (s.normFLo     != null) _S.normFLo     = s.normFLo;
      if (s.normFHi     != null) _S.normFHi     = s.normFHi;
      if (s.bandShading != null) _S.bandShading = s.bandShading;
      _syncControls();
      render();
    }
    $('new-test-menu').classList.remove('open');
  };

  window.expScratch = function() {
    alert('You pressed: Scratch\n\nThis starts a blank scratch session.');
  };

  // ── Toolbar: Settings ─────────────────────────────────────────────────
  window.expSettings = function(e) {
    e.stopPropagation();
    const m = $('settings-menu'); if (!m) return;
    m.classList.toggle('open');
    document.body.addEventListener('click', () => m.classList.remove('open'), {once:true});
  };
  // ── Preferences modal ─────────────────────────────────────────────────
  const _PREF_DEFAULTS = {
    defaultWavUrl: '../../sample-data/1-Tchaikovsky-short.wav',
    outputDeviceId: '',
    yDbRange: 38, xMin: 200, xMax: 7000, lineWidth: 1.0,
  };

  function _loadPrefs() {
    try { return { ..._PREF_DEFAULTS, ...JSON.parse(localStorage.getItem('obieExplore_prefs') || '{}') }; }
    catch(_) { return { ..._PREF_DEFAULTS }; }
  }

  function _applyPrefsToForm(p) {
    const storedName = localStorage.getItem('obieExplore_wavName');
    const set = (id, val) => { const el = $('pref-' + id); if (el && val != null) el.value = val; };
    set('wav-url',   storedName || p.defaultWavUrl || _PREF_DEFAULTS.defaultWavUrl);
    set('yrange',    p.yDbRange  ?? _PREF_DEFAULTS.yDbRange);
    set('xmin',      p.xMin      ?? _PREF_DEFAULTS.xMin);
    set('xmax',      p.xMax      ?? _PREF_DEFAULTS.xMax);
    set('linewidth', p.lineWidth ?? _PREF_DEFAULTS.lineWidth);
    const sel = $('pref-device');
    if (sel && p.outputDeviceId) sel.value = p.outputDeviceId;
  }

  async function _enumeratePrefsOutputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const sel = $('pref-device'); if (!sel) return;
      const saved = _loadPrefs().outputDeviceId;
      sel.innerHTML = '<option value="">Default output</option>';
      devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default').forEach(d => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Speaker (${d.deviceId.slice(0,8)}…)`;
        if (d.deviceId === saved) o.selected = true;
        sel.appendChild(o);
      });
    } catch(_) {}
  }

  window.expPreferences = function() {
    _applyPrefsToForm(_loadPrefs());
    _enumeratePrefsOutputs();
    $('prefs-modal')?.classList.add('open');
  };
  window.expClosePrefs = () => $('prefs-modal')?.classList.remove('open');

  async function _saveExploreJson() {
    if (!_exploreSettingsHandle) return;
    try {
      const data = { lineWidth: _S.lineWidth, yDbRange: _S.yDbRange, xMin: _S.xMin, xMax: _S.xMax };
      const fh = await _exploreSettingsHandle.getFileHandle('explore.json', { create: true });
      const w  = await fh.createWritable();
      await w.write(JSON.stringify(data, null, 2));
      await w.close();
    } catch (_) {}
  }

  window.expSavePrefs = function() {
    const g = id => $('pref-' + id)?.value ?? '';
    const p = {
      defaultWavUrl:  g('wav-url').trim() || _PREF_DEFAULTS.defaultWavUrl,
      outputDeviceId: g('device'),
      yDbRange:   parseFloat(g('yrange'))    || _PREF_DEFAULTS.yDbRange,
      xMin:       parseFloat(g('xmin'))      || _PREF_DEFAULTS.xMin,
      xMax:       parseFloat(g('xmax'))      || _PREF_DEFAULTS.xMax,
      lineWidth:  parseFloat(g('linewidth')) || _PREF_DEFAULTS.lineWidth,
    };
    localStorage.setItem('obieExplore_prefs', JSON.stringify(p));
    localStorage.setItem('obieExplore_defaultWavUrl', p.defaultWavUrl);
    _S.yDbRange = p.yDbRange; _S.xMin = p.xMin; _S.xMax = p.xMax; _S.lineWidth = p.lineWidth;
    _syncControls(); render();
    _saveExploreJson();   // also persist to ObieAppSettings/explore.json
    const st = $('prefs-save-msg');
    if (st) { st.textContent = '✓ Saved'; setTimeout(() => st.textContent = '', 2500); }
  };

  window.expResetPrefs = function() {
    localStorage.removeItem('obieExplore_prefs');
    localStorage.removeItem('obieExplore_defaultWavUrl');
    localStorage.removeItem('obieExplore_wavName');
    _IDB.del('wavData').catch(() => {});
    _applyPrefsToForm(_PREF_DEFAULTS);
    _S.yDbRange = _PREF_DEFAULTS.yDbRange; _S.xMin = _PREF_DEFAULTS.xMin;
    _S.xMax = _PREF_DEFAULTS.xMax; _S.lineWidth = _PREF_DEFAULTS.lineWidth;
    _syncControls(); render();
    const st = $('prefs-save-msg');
    if (st) { st.textContent = '✓ Reset to defaults'; setTimeout(() => st.textContent = '', 2500); }
  };

  window.expBrowseWav = function() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.wav,audio/wav';
    input.onchange = async () => {
      const file = input.files[0]; if (!file) return;
      const ab = await file.arrayBuffer();
      await _IDB.put('wavData', ab);
      localStorage.setItem('obieExplore_wavName', file.name);
      localStorage.removeItem('obieExplore_defaultWavUrl');
      const el = $('pref-wav-url'); if (el) el.value = file.name;
      const st = $('prefs-save-msg');
      if (st) { st.textContent = '✓ WAV stored locally'; setTimeout(() => st.textContent = '', 2500); }
    };
    input.click();
  };

  window.expLiveView = function() { window.open('liveview.html', '_blank'); };

  // ── Toolbar: misc buttons ─────────────────────────────────────────────
  window.expFun            = () => alert('You pressed: Fun');
  window.expShortcuts      = () => alert('You pressed: Shortcuts');
  window.expHelp           = () => alert('You pressed: Help');
  window.expGettingStarted = () => alert('You pressed: Getting Started');

  // ── Data Folder helpers ───────────────────────────────────────────────
  const _SCAN_EXTS = new Set(['.trf','.trv','.avc','.avr','.csv','.wav']);

  async function _countTopDirs(dh) {
    let n = 0;
    for await (const [, h] of dh.entries()) { if (h.kind === 'directory') n++; }
    return n;
  }

  async function _scanDir(dh, relPath) {
    const out = [];
    for await (const [name, h] of dh.entries()) {
      if (h.kind === 'file') {
        const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
        if (_SCAN_EXTS.has(ext))
          out.push({ name, ext, path: relPath ? relPath + '/' + name : name, handle: h });
      } else if (h.kind === 'directory') {
        if (name === 'ObieAppSettings') continue;
        const sub = await _scanDir(h, relPath ? relPath + '/' + name : name);
        for (const f of sub) out.push(f);
      }
    }
    return out;
  }

  async function _applyFolder(dir) {
    const st = $('explore-status');
    if (st) st.textContent = 'Scanning folder…';
    _dataDir  = dir;
    _dirFiles = await _scanDir(dir, '');

    // Load settings, bands, and templates from ObieAppSettings/
    try {
      let templatesHandle;
      ({ settingsHandle: _exploreSettingsHandle, bandsHandle: _bandsHandle, templatesHandle }
        = await openObieAppSettings(dir));

      // Load explore prefs from explore.json
      try {
        const file  = await (await _exploreSettingsHandle.getFileHandle('explore.json')).getFile();
        const prefs = JSON.parse(await file.text());
        if (prefs.lineWidth != null) _S.lineWidth = prefs.lineWidth;
        if (prefs.yDbRange  != null) _S.yDbRange  = prefs.yDbRange;
        if (prefs.xMin      != null) _S.xMin      = prefs.xMin;
        if (prefs.xMax      != null) _S.xMax      = prefs.xMax;
        _syncControls();
        render();
      } catch (_) {}

      // Load bands from ObieAppSettings/bands/
      if (_bandsHandle) await _loadBandsFromFolder(_bandsHandle);

      // Load templates from ObieAppSettings/Templates/
      try {
        for await (const [name, h] of templatesHandle.entries()) {
          if (h.kind !== 'file' || !name.toLowerCase().endsWith('.json')) continue;
          try {
            const tpl = JSON.parse(await (await h.getFile()).text());
            _templates.push(...(Array.isArray(tpl) ? tpl : [tpl]));
          } catch (_) {}
        }
        const menu = $('new-test-menu');
        if (menu) menu.innerHTML = _templates.map((t, i) =>
          `<button class="menu-item" onclick="expPickTemplate(${i})">${_esc(t.name)}</button>`
        ).join('');
      } catch (_) {}
    } catch (_) {}

    const nDirs = await _countTopDirs(dir);
    const btn = $('data-folder-btn');
    if (btn) btn.textContent = '📁 ' + dir.name;
    const ind = $('folder-name-ind');
    if (ind) ind.textContent = dir.name + (nDirs > 0 ? '  (' + nDirs + ' instruments)' : '');
    if (st) { st.textContent = `Folder: ${dir.name} — ${_dirFiles.length} files`; setTimeout(() => st.textContent = '', 4000); }
  }

  // ── Data Folder ───────────────────────────────────────────────────────
  window.expSetDataFolder = async function() {
    if (!window.showDirectoryPicker) {
      alert('Directory picker not supported in this browser.\nUse Browse to open individual files.');
      return;
    }
    try {
      // Always show picker — Chrome defaults to the last-used location naturally.
      // (requestPermission() before showDirectoryPicker() consumes the user gesture
      //  and causes the picker to silently fail, so we skip that step here.)
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      // Clear saved path when switching to a different folder
      if (localStorage.getItem('obieExplore_folderName') !== dir.name)
        localStorage.removeItem('obieExplore_folderPath');
      await _applyFolder(dir);
      _IDB.put('dataFolderHandle', dir).catch(() => {});
      localStorage.setItem('obieExplore_folderName', dir.name);
      saveDataFolderHandle(dir).catch(() => {});  // sync to shared cross-tool IDB
    } catch(e) { if (e.name !== 'AbortError') console.warn('expSetDataFolder:', e); }
  };

  // ── Search modal ──────────────────────────────────────────────────────
  window.expSearch = function() {
    if (!_dataDir) {
      alert('Set a Data Folder first (use the 📁 Data Folder button).');
      return;
    }
    $('search-modal')?.classList.add('open');
    _runSearch();
  };
  window.expCloseSearch = () => $('search-modal')?.classList.remove('open');

  function _runSearch() {
    const pattern = ($('search-pattern')?.value || '').trim();
    const kw1 = ($('search-kw1')?.value || '').trim().toLowerCase();
    const kw2 = ($('search-kw2')?.value || '').trim().toLowerCase();
    const kw3 = ($('search-kw3')?.value || '').trim().toLowerCase();

    const ftAll = $('ft-all')?.checked;
    const ftAvR = $('ft-avr')?.checked;
    const ftAvC = $('ft-avc')?.checked;
    const ftTrf = $('ft-trf')?.checked;
    const ftWav = $('ft-wav')?.checked;

    const patterns = pattern ? pattern.split(',').map(p => p.trim()).filter(Boolean) : [];
    const keywords = [kw1, kw2, kw3].filter(Boolean);

    _searchResults = _dirFiles.filter(f => {
      const n = f.name.toLowerCase();

      // File type filter
      if (!ftAll) {
        const ok = (ftAvR && f.ext === '.avr') ||
                   (ftAvC && f.ext === '.avc') ||
                   (ftTrf && (f.ext === '.trf' || f.ext === '.trv')) ||
                   (ftWav && f.ext === '.wav');
        if (!ok) return false;
      }

      // Pattern: filename must contain at least one (case-insensitive)
      if (patterns.length && !patterns.some(p => n.includes(p.toLowerCase()))) return false;

      // Keywords: OR — at least one must match (if any specified)
      if (keywords.length && !keywords.some(k => n.includes(k))) return false;

      return true;
    });

    const countEl = $('search-count');
    if (countEl) countEl.textContent = _searchResults.length;

    const list = $('search-results-list');
    if (!list) return;
    if (!_searchResults.length) {
      list.innerHTML = '<div class="sr-empty">No matching files</div>';
      return;
    }
    // All results start selected (blue) — user deselects what they don't want
    list.innerHTML = _searchResults.map((f, i) =>
      `<div class="sr-item selected" data-idx="${i}" onclick="expToggleSearchItem(this)">${_esc(f.name)}</div>`
    ).join('');
  }

  window.expToggleSearchItem = function(el) { el.classList.toggle('selected'); };

  window.expSelectAllSearch  = function() {
    document.querySelectorAll('#search-results-list .sr-item').forEach(el => el.classList.add('selected'));
  };
  window.expSelectNoneSearch = function() {
    document.querySelectorAll('#search-results-list .sr-item').forEach(el => el.classList.remove('selected'));
  };

  window.expLoadSelected = async function() {
    const selected = [...document.querySelectorAll('#search-results-list .sr-item.selected')];
    if (!selected.length) { alert('No files selected.'); return; }
    if (!window.pyExploreLoadFile) { alert('Python not ready — try again.'); return; }
    $('search-modal')?.classList.remove('open');
    for (const el of selected) {
      const f = _searchResults[+el.dataset.idx]; if (!f) continue;
      try {
        const file = await f.handle.getFile();
        _pendingPaths[f.name] = f.path;  // store path so obieExploreAddDataset can attach it
        window.pyExploreLoadFile(f.name, new Uint8Array(await file.arrayBuffer()));
      } catch(e) { console.warn('load error', f.name, e); }
    }
  };

  function _wireSearchFilters() {
    ['search-pattern','search-kw1','search-kw2','search-kw3'].forEach(id => {
      const el = $(id); if (el) el.addEventListener('input', _runSearch);
    });
    ['ft-avr','ft-avc','ft-trf','ft-wav','ft-all'].forEach(id => {
      const el = $(id); if (!el) return;
      el.addEventListener('change', e => {
        if (id === 'ft-all' && e.target.checked)
          ['ft-avr','ft-avc','ft-trf','ft-wav'].forEach(o => { const x=$(o); if(x) x.checked=false; });
        else if (id !== 'ft-all' && e.target.checked) {
          const a=$('ft-all'); if(a) a.checked=false;
        }
        _runSearch();
      });
    });
  }

  // ── File ops ──────────────────────────────────────────────────────────

  window.expBrowse = function() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = '.trf,.trv,.avc,.avr,.csv';
    inp.addEventListener('change', async () => {
      if (!window.pyExploreLoadFile) { alert('Python not ready — try again.'); return; }
      for (const f of inp.files)
        window.pyExploreLoadFile(f.name, new Uint8Array(await f.arrayBuffer()));
    });
    inp.click();
  };

  window.expLists = function() {
    const modal = $('lists-modal'); if (!modal) return;
    const box = modal.querySelector('.lists-content');
    if (box) {
      box.innerHTML = _lists.length
        ? _lists.map(l =>
            `<div class="list-item">
              <div class="list-name">${_esc(l.name)}</div>
              <div class="list-desc">${_esc(l.description||'')}</div>
              <ul class="list-files">${(l.files||[]).map(f=>`<li>${_esc(f)}</li>`).join('')}</ul>
            </div>`
          ).join('')
        : '<p class="muted-txt">No predefined lists found.</p>';
    }
    modal.classList.add('open');
  };
  window.expCloseLists = () => $('lists-modal')?.classList.remove('open');

  window.expShare = function() {
    const vis = _datasets.filter(d => d.visible);
    if (!vis.length) { alert('No visible datasets to export.'); return; }
    const allFreqs = [...new Set(vis.flatMap(d => d.freqs))].sort((a,b)=>a-b);
    const header = ['Frequency_Hz', ...vis.map(d => d.name.replace(/[,\n"]/g,'_'))].join(',');
    const rows = allFreqs.map(f => {
      const vals = vis.map(d => {
        const idx = d.freqs.indexOf(f);
        return idx >= 0 ? d.mags[idx].toFixed(4) : '';
      });
      return [f, ...vals].join(',');
    });
    const csv = [header, ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    const a = document.createElement('a');
    a.href = url; a.download = 'explore_export_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click(); URL.revokeObjectURL(url);
  };

  window.expColors = function() { $('colors-modal')?.classList.add('open'); };
  window.expCloseColors = () => $('colors-modal')?.classList.remove('open');
  window.expPickPalette = function(name) {
    _palette = PALETTES[name] || PALETTES.default;
    _datasets.forEach((d,i) => d.color = _palette[i % _palette.length]);
    _renderList(); render();
    $('colors-modal')?.classList.remove('open');
  };

  // ── Plot controls ─────────────────────────────────────────────────────
  window.expToggleYLog = function() { _S.yLog = !_S.yLog; _syncAxisBtns(); render(); };
  window.expRescaleY   = function() { _S.yMin = null; _S.yMax = null; render(); };
  window.expSetYDbRange = function(v) { _S.yDbRange = parseFloat(v) || 38; render(); };
  window.expSetXRange  = function() {
    const mn = parseFloat($('x-min-inp')?.value), mx = parseFloat($('x-max-inp')?.value);
    if (isFinite(mn)) _S.xMin = mn; if (isFinite(mx)) _S.xMax = mx;
    render();
  };
  window.expToggleXLog = function() { _S.xLog = !_S.xLog; _syncAxisBtns(); render(); };
  window.expSetSmoothing = function(v) { _S.smoothing = parseFloat(v) || 0; render(); };
  window.expSetNormalize = function(v) {
    _S.normMode = v;   // 'as_measured' | 'normalize' | 'avg_range'
    _S.normalize = v === 'normalize';  // keep legacy field in sync
    const wrap = $('norm-range-wrap');
    if (wrap) wrap.style.display = v === 'avg_range' ? 'flex' : 'none';
    render();
  };
  window.expSetNormRange = function() {
    const lo = parseFloat($('norm-f-lo')?.value), hi = parseFloat($('norm-f-hi')?.value);
    if (isFinite(lo)) _S.normFLo = lo;
    if (isFinite(hi)) _S.normFHi = hi;
    render();
  };
  window.expToggleBandShading = function(v) { _S.bandShading = !!v; render(); };
  window.expSetBandPreset = function(v) {
    if (v === 'custom') { expCustomBands(); return; }
    _S.bandPreset = v; render();
  };
  window.expCustomBands = function() {
    const input = prompt(
      'Enter custom band boundaries (Hz), comma-separated.\nExample: 200,500,1000,2000,4000,7000'
    );
    if (!input) return;
    const edges = input.split(',').map(s => parseFloat(s.trim())).filter(isFinite);
    if (edges.length < 2) { alert('Need at least 2 boundary values.'); return; }
    _customBands = [];
    for (let i = 0; i < edges.length - 1; i++)
      _customBands.push({label: `${edges[i]}–${edges[i+1]}`, f_lo: edges[i], f_hi: edges[i+1]});
    _S.bandPreset = 'custom';
    const sel = $('band-sel'); if (sel) { const o = document.createElement('option'); o.value='custom'; o.textContent='Custom'; sel.appendChild(o); sel.value='custom'; }
    render();
  };
  window.expExportBands = function() {
    if (!window._exploreLastBandData?.length) { alert('Select a band preset first.'); return; }
    const rows = ['Band,f_lo_Hz,f_hi_Hz,avg_dB,centroid_Hz'];
    window._exploreLastBandData.forEach(b =>
      rows.push(`${b.label},${b.f_lo},${b.f_hi},${b.avg_db.toFixed(3)},${b.centroid.toFixed(1)}`)
    );
    const url = URL.createObjectURL(new Blob([rows.join('\n')], {type:'text/csv'}));
    const a = document.createElement('a'); a.href=url; a.download='band_data.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Interpret modal ───────────────────────────────────────────────────
  window.expInterpret = function() {
    const modal = $('interpret-modal'); if (!modal) return;
    modal.classList.add('open');
    const vis = _datasets.filter(d => d.visible);
    const traces = vis.map(d => {
      let mags = _smooth(d.freqs, d.mags, _S.smoothing);
      mags = _applyNorm(d.freqs, mags);
      return {x:d.freqs, y:mags, type:'scatter', mode:'lines', name:d.name, line:{color:d.color, width:1.5}, showlegend:true};
    });
    // String mode tick marks at bottom
    STRING_MODES.forEach(m => traces.push({
      x:[m.freq,m.freq], y:[-35,-28], type:'scatter', mode:'lines+text',
      text:['',m.label], textposition:'bottom center',
      line:{color:'#c00', width:1.5, dash:'dot'},
      showlegend:false, textfont:{color:'#c00', size:11},
    }));
    if (!traces.length) traces.push({x:[],y:[],type:'scatter',mode:'lines',showlegend:false});

    const shapes = INTERPRET_REGIONS.map(r => ({
      type:'rect', xref:'x', yref:'paper', x0:r.f_lo, x1:r.f_hi, y0:0, y1:1,
      fillcolor:r.color, opacity:0.1, line:{width:0},
    }));
    const annotations = INTERPRET_REGIONS.map(r => ({
      x: Math.sqrt(r.f_lo * r.f_hi), xref:'x', y:1.05, yref:'paper',
      text: r.label, showarrow:false, font:{color:r.color, size:11}, xanchor:'center',
    }));
    // Typical range bars near top
    [{lo:264,hi:290},{lo:380,hi:420},{lo:393,hi:470},{lo:473,hi:593}].forEach((r,i) => {
      shapes.push({type:'line', xref:'x', yref:'paper', x0:r.lo, x1:r.hi, y0:0.97-i*0.015, y1:0.97-i*0.015, line:{color:'#888',width:3}});
    });

    Plotly.react('interpret-plot', traces, {
      paper_bgcolor:'white', plot_bgcolor:'white',
      font:{color:'#333', family:'inherit', size:12},
      margin:{l:65, r:16, t:50, b:60},
      showlegend: traces.length > 1,
      legend:{x:1, xanchor:'right', y:1, font:{size:10}},
      xaxis:{title:'Frequency (Hz)', type:'log', range:[Math.log10(200), Math.log10(10000)], gridcolor:'#ddd', zerolinecolor:'#ddd'},
      yaxis:{title:'Intensity (dB)', gridcolor:'#ddd', zerolinecolor:'#ddd'},
      shapes, annotations,
    }, {responsive:true, displayModeBar:false});
  };
  window.expCloseInterpret = () => $('interpret-modal')?.classList.remove('open');

  // ── Sync controls ─────────────────────────────────────────────────────
  function _syncControls() {
    const xMin = $('x-min-inp'), xMax = $('x-max-inp');
    if (xMin) xMin.value = _S.xMin; if (xMax) xMax.value = _S.xMax;
    const yRange = $('y-db-range'); if (yRange) yRange.value = _S.yDbRange;
    const sm = $('smooth-sel'); if (sm) sm.value = String(_S.smoothing);
    const nm = $('norm-sel');
    if (nm) nm.value = _S.normMode || (_S.normalize ? 'normalize' : 'as_measured');
    const wrap = $('norm-range-wrap');
    if (wrap) wrap.style.display = _S.normMode === 'avg_range' ? 'flex' : 'none';
    const loEl = $('norm-f-lo'), hiEl = $('norm-f-hi');
    if (loEl) loEl.value = _S.normFLo; if (hiEl) hiEl.value = _S.normFHi;
    const shadeChk = $('band-shade-chk'); if (shadeChk) shadeChk.checked = _S.bandShading;
    _syncAxisBtns();
  }
  function _syncAxisBtns() {
    const yl = $('y-log-btn');
    if (yl) { yl.textContent = _S.yLog ? 'Y=log' : 'Y=lin'; yl.classList.toggle('active', _S.yLog); }
    const xl = $('x-log-btn');
    if (xl) { xl.textContent = _S.xLog ? 'X=log' : 'X=lin'; xl.classList.toggle('active', _S.xLog); }
  }

  // ── Hover readout ─────────────────────────────────────────────────────
  function _setupHover() {
    const el = $('explore-plot'); if (!el) return;
    el.on('plotly_hover', data => {
      if (!data.points?.length) return;
      const pt = data.points[0]; if (!isFinite(pt.y)) return;
      const ro = $('hover-readout');
      if (ro) ro.textContent = `Amp = ${pt.y.toFixed(1)} dB,  Freq = ${Number(pt.x).toFixed(0)} Hz`;
    });
    el.on('plotly_unhover', () => { const ro=$('hover-readout'); if(ro) ro.textContent=''; });
  }

  // ── Drag-and-drop onto plot ───────────────────────────────────────────
  function _setupDropZone() {
    const area = $('explore-drop-area'); if (!area) return;
    ['dragenter','dragover'].forEach(ev => area.addEventListener(ev, e => {
      e.preventDefault(); area.classList.add('dragging');
    }));
    ['dragleave','drop'].forEach(ev => area.addEventListener(ev, e => {
      e.preventDefault(); area.classList.remove('dragging');
    }));
    area.addEventListener('drop', async e => {
      if (!window.pyExploreLoadFile) { alert('Python not ready.'); return; }
      for (const f of (e.dataTransfer?.files||[]))
        window.pyExploreLoadFile(f.name, new Uint8Array(await f.arrayBuffer()));
    });
  }

  // ── Resizable sidebar splitter ────────────────────────────────────────
  function _setupResizer() {
    const resizer = $('ex-resizer');
    const sidebar = document.querySelector('.ex-sidebar');
    if (!resizer || !sidebar) return;

    // Restore saved width
    const saved = parseInt(localStorage.getItem('obieExplore_sidebarW'));
    if (saved >= 80) sidebar.style.width = saved + 'px';

    resizer.addEventListener('mousedown', e => {
      const startX = e.clientX;
      const startW = sidebar.offsetWidth;
      resizer.classList.add('dragging');
      document.body.classList.add('resizing');

      function onMove(e) {
        const w = Math.max(80, Math.min(500, startW + e.clientX - startX));
        sidebar.style.width = w + 'px';
        Plotly.Plots.resize('explore-plot');
      }
      function onUp() {
        resizer.classList.remove('dragging');
        document.body.classList.remove('resizing');
        localStorage.setItem('obieExplore_sidebarW', sidebar.offsetWidth);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  // ── Python-side callbacks ─────────────────────────────────────────────
  window.obieExploreAddDataset = function(name, freqsJs, magsJs) {
    const n = String(name).split('/').pop().split('\\').pop();
    _saveUndo();
    const id = _nextId++;
    const color = _palette[_datasets.length % _palette.length];
    const path  = _pendingPaths[n] || n;
    delete _pendingPaths[n];
    _datasets.push({id, name:n, path, color, visible:true, freqs:Array.from(freqsJs), mags:Array.from(magsJs)});
    _renderList(); render();
    const st = $('explore-status');
    if (st) { st.textContent = `✓ ${n}`; setTimeout(()=>st.textContent='', 3000); }
  };

  window.obieExploreError = function(name, msg) {
    const st = $('explore-status');
    if (st) { st.textContent = `Error: ${msg}`; st.style.color='var(--red,#c00)'; setTimeout(()=>{st.textContent=''; st.style.color='';}, 5000); }
    console.error(`[Explore] ${name}: ${msg}`);
  };

  window.obieExploreWavReady = function(info) {
    const el = $('wav-info'); if (el) el.textContent = '✓ WAV: ' + info;
  };
  window.obieExploreWavError = function(msg) {
    const el = $('wav-info'); if (el) el.textContent = 'WAV error: ' + msg;
  };

  window.obieExploreReady = function() {
    $('loading')?.classList.add('gone');
    // Load default WAV — try IDB-stored file first, then fall back to URL
    (async () => {
      try {
        const wavData = await _IDB.get('wavData');
        if (wavData) {
          const name = localStorage.getItem('obieExplore_wavName') || 'snippet.wav';
          if (window.pyExploreSetWav) window.pyExploreSetWav(new Uint8Array(wavData), name);
          return;
        }
      } catch(_) {}
      const url = localStorage.getItem('obieExplore_defaultWavUrl')
        || '../../sample-data/1-Tchaikovsky-short.wav';
      fetch(url)
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status))
        .then(ab => window.pyExploreSetWav && window.pyExploreSetWav(new Uint8Array(ab), url.split('/').pop()))
        .catch(e => console.warn('Default WAV fetch failed:', e));
    })();

    // Restore saved settings — prefs first (baseline), then session state on top
    try {
      const prefs = JSON.parse(localStorage.getItem('obieExplore_prefs') || '{}');
      if (prefs.lineWidth != null) _S.lineWidth = prefs.lineWidth;
      if (prefs.yDbRange  != null) _S.yDbRange  = prefs.yDbRange;
      if (prefs.xMin      != null) _S.xMin      = prefs.xMin;
      if (prefs.xMax      != null) _S.xMax      = prefs.xMax;
    } catch(_) {}
    try {
      const saved = JSON.parse(localStorage.getItem('obieExplore_plotState') || '{}');
      Object.assign(_S, saved);
    } catch(_) {}
    _syncControls();
    _populateBandSel();  // build dropdown from _dynamicBandPresets (empty until folder loaded)
    render();
    _setupHover();
    _setupDropZone();
    _syncUndoBtn();
    _renderList();
    window.addEventListener('resize', () => Plotly.Plots.resize('explore-plot'));

    // Restore last data folder display, auto-rescan if permission already granted
    const savedName = localStorage.getItem('obieExplore_folderName');
    const _pathInd  = $('folder-name-ind');
    if (_pathInd && savedName) _pathInd.textContent = savedName + '  (click 📁 to reconnect)';
    if (savedName) {
      _IDB.get('dataFolderHandle').then(async h => {
        if (!h) return;
        const perm = await h.queryPermission({ mode: 'read' }).catch(() => 'denied');
        if (perm !== 'granted') return;
        await _applyFolder(h);
      }).catch(() => {});
    }
  };

  // Save plot state on page hide
  window.addEventListener('pagehide', () => {
    try { localStorage.setItem('obieExplore_plotState', JSON.stringify(_S)); } catch(_) {}
  });

  // Live-apply preferences saved from the preferences tab (storage event fires in other tabs)
  window.addEventListener('storage', e => {
    if (e.key !== 'obieExplore_prefs') return;
    try {
      const prefs = JSON.parse(e.newValue || '{}');
      if (prefs.lineWidth != null) _S.lineWidth = prefs.lineWidth;
      if (prefs.yDbRange  != null) _S.yDbRange  = prefs.yDbRange;
      if (prefs.xMin      != null) _S.xMin      = prefs.xMin;
      if (prefs.xMax      != null) _S.xMax      = prefs.xMax;
      if (_exploreSettingsHandle) {
        (async () => {
          try {
            const fh = await _exploreSettingsHandle.getFileHandle('explore.json', { create: true });
            const w  = await fh.createWritable();
            await w.write(JSON.stringify(prefs, null, 2));
            await w.close();
          } catch (_) {}
        })();
      }
    } catch(_) {}
    _syncControls();
    render();
  });

  // ── Load templates + lists ────────────────────────────────────────────
  fetch('./templates.json').then(r=>r.json()).then(d=>{
    _templates = d.templates||[];
    const menu = $('new-test-menu'); if (!menu) return;
    menu.innerHTML = _templates.map((t,i)=>
      `<button class="menu-item" onclick="expPickTemplate(${i})">${_esc(t.name)}</button>`
    ).join('');
  }).catch(()=>{});

  fetch('./lists.json').then(r=>r.json()).then(d=>{ _lists = d.lists||[]; }).catch(()=>{});

  // ── Boot ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    Plotly.newPlot('explore-plot', [], {
      paper_bgcolor:'transparent', plot_bgcolor:'transparent',
      margin:{l:65, r:16, t:12, b:50}, autosize:true,
      xaxis:{title:'Frequency (Hz)', type:'log', range:[Math.log10(200),Math.log10(7000)]},
      yaxis:{title:'Magnitude (dB)'},
    }, {responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['sendDataToCloud']});
    _syncUndoBtn();
    _renderList();
    _syncAxisBtns();
    _wireSearchFilters();
    _setupResizer();
  });

})();
