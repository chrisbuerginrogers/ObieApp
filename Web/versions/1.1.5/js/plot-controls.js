/* ─────────────────────────────────────────────────────────────────────
 * plot-controls.js
 * Owns all trace data and plot state.
 *
 * Public API (called from Python):
 *   obieInitPlotControls(divId, opts)
 *   obieAddTrace(x, y, name)
 *   obieClearPlot()
 *
 * File-list UI features (all in JS):
 *   • Colour swatch — click to open native colour picker
 *   • Right-click on trace name — also opens colour picker
 *   • 🗑 button — removes that trace
 *
 * Y-axis auto-rescales to data visible in the current X window.
 * ───────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const PALETTE = [
    '#ff6f00', '#2196f3', '#4caf50', '#e91e63', '#9c27b0',
    '#00bcd4', '#ff5722', '#8bc34a', '#ffc107', '#607d8b',
  ];

  const BAND_COLORS = [
    '#e74c3c', '#e67e22', '#2ecc71', '#3498db', '#9b59b6',
  ];

  // Band overlay state — rebuilt by obieSetBands, cleared by obieClearBands
  let bandShapes = [];
  let bandTraces = [];

  const state = {
    plotDiv:   'plot',
    xLabel:    'Frequency [Hz]',
    yLabel:    'Magnitude [dB]',
    xLog:      true,
    yLog:      true,
    xMin:      200, xMax: 7000,
    yMin:      null, yMax: null,
    lineWidth: 1.8,
  };

  // Each trace: { x:[], y:[], name:'', color:'' }
  let traces = [];

  function $(id) { return document.getElementById(id); }

  function _esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ── Auto y-range: 2nd–98th percentile of visible data ─────────── */
  function _visibleYRange() {
    if (!traces.length) return null;
    const xLo = state.xMin != null ? state.xMin : -Infinity;
    const xHi = state.xMax != null ? state.xMax :  Infinity;

    const vals = [];
    for (const t of traces) {
      for (let i = 0; i < t.x.length; i++) {
        if (t.x[i] >= xLo && t.x[i] <= xHi && isFinite(t.y[i])) {
          vals.push(t.y[i]);
        }
      }
    }
    if (!vals.length) return null;

    // Sort and take 2nd–98th percentile to exclude extreme notch values
    vals.sort((a, b) => a - b);
    const lo = vals[Math.max(0, Math.floor(vals.length * 0.02))];
    const hi = vals[Math.min(vals.length - 1, Math.ceil(vals.length * 0.98) - 1)];
    const pad = (hi - lo) * 0.08 || 1;
    return [lo - pad, hi + pad];
  }

  /* ── Render plot ─────────────────────────────────────────────────── */
  function render() {
    // Auto y when user hasn't set manual limits (bands excluded from range calc)
    const autoY = (state.yMin == null && state.yMax == null)
      ? _visibleYRange() : null;

    const s = autoY
      ? { ...state, yMin: autoY[0], yMax: autoY[1] }
      : state;

    const layout = window.obieBuildPlotLayout(s);
    if (bandShapes.length) layout.shapes = bandShapes;

    const frhTraces = traces.length
      ? traces.map(t => ({
          x: t.x, y: t.y,
          type: 'scatter', mode: 'lines',
          name: t.name,
          line: { color: t.color, width: state.lineWidth },
          showlegend: false,
        }))
      : [{ x: [], y: [], type: 'scatter', mode: 'lines',
           line: { color: PALETTE[0], width: state.lineWidth },
           showlegend: false }];

    Plotly.react(state.plotDiv, [...frhTraces, ...bandTraces],
                 layout, window.OBIE_PLOT_CONFIG);
  }

  /* ── Band table ──────────────────────────────────────────────────── */
  function _renderBandTable(bands) {
    const el = document.getElementById('band-table');
    if (!el) return;
    if (!bands || !bands.length) {
      el.innerHTML = '<span class="muted">select a preset above</span>';
      return;
    }
    const rows = bands.map((b, i) => {
      const c = BAND_COLORS[i % BAND_COLORS.length];
      return `<tr>
        <td><span class="band-dot" style="background:${c}"></span>${b.label}</td>
        <td>${b.avg_db.toFixed(1)}</td>
        <td>${b.centroid.toFixed(0)}</td>
      </tr>`;
    }).join('');
    el.innerHTML =
      '<table class="band-table">' +
        '<thead><tr><th>Band</th><th>Avg (dB)</th><th>Centroid (Hz)</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  /* ── File list rendering ─────────────────────────────────────────── */
  function renderFileList() {
    const box = $('file-list');
    if (!box) return;
    if (!traces.length) {
      box.innerHTML = '<span class="muted">none</span>';
      return;
    }
    box.innerHTML = traces.map((t, i) =>
      '<div class="file-item" data-idx="' + i + '">' +
        '<span class="color-swatch" data-idx="' + i + '" ' +
          'style="background:' + t.color + '" title="Click to change colour"></span>' +
        '<span class="trace-name" data-idx="' + i + '" title="Right-click to change colour">'
          + _esc(t.name) + '</span>' +
        '<button class="trash-btn" data-idx="' + i + '" title="Remove trace">🗑</button>' +
      '</div>'
    ).join('');

    // Colour swatches — left click
    box.querySelectorAll('.color-swatch').forEach(el =>
      el.addEventListener('click', () => _pickColor(+el.dataset.idx)));

    // Right-click on name also opens picker
    box.querySelectorAll('.trace-name').forEach(el =>
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        _pickColor(+el.dataset.idx);
      }));

    // Trash buttons
    box.querySelectorAll('.trash-btn').forEach(el =>
      el.addEventListener('click', () => {
        traces.splice(+el.dataset.idx, 1);
        renderFileList();
        render();
      }));
  }

  function _pickColor(idx) {
    const inp = document.createElement('input');
    inp.type  = 'color';
    inp.value = traces[idx].color;
    inp.addEventListener('input', e => {
      traces[idx].color = e.target.value;
      renderFileList();
      render();
    });
    inp.click();
  }

  /* ── Toggle wiring ──────────────────────────────────────────────── */
  function setToggle(groupId, axis, val) {
    const grp = $(groupId);
    if (grp) grp.querySelectorAll('button').forEach(b =>
      b.classList.toggle('active', b.dataset.scale === val));
    if (axis === 'x') state.xLog = (val === 'log');
    else              state.yLog = (val === 'log');
    render();
  }
  function wireToggle(groupId, axis) {
    const grp = $(groupId); if (!grp) return;
    grp.querySelectorAll('button').forEach(btn =>
      btn.addEventListener('click', () => setToggle(groupId, axis, btn.dataset.scale)));
  }

  /* ── Range inputs ───────────────────────────────────────────────── */
  function readNum(id) {
    const el = $(id); if (!el) return null;
    const v = parseFloat(el.value.trim());
    return isFinite(v) ? v : null;
  }
  function syncInputs() {
    const set = (id, v) => { const e=$(id); if (e && v != null) e.value = v; };
    set('x-min', state.xMin); set('x-max', state.xMax);
  }
  function wireRange(inputId, key) {
    const el = $(inputId); if (!el) return;
    el.addEventListener('change', () => { state[key] = readNum(inputId); render(); });
  }
  function wireAutoscale(btnId) {
    const b = $(btnId); if (!b) return;
    b.addEventListener('click', () => {
      state.xMin = state.xMax = state.yMin = state.yMax = null;
      ['x-min','x-max','y-min','y-max'].forEach(id => { const e=$(id); if(e) e.value=''; });
      render();
    });
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  window.obieInitPlotControls = function (divId, opts) {
    state.plotDiv = divId;
    Object.assign(state, opts || {});
    setToggle('x-scale-toggle', 'x', state.xLog ? 'log' : 'linear');
    setToggle('y-scale-toggle', 'y', state.yLog ? 'log' : 'linear');
    wireToggle('x-scale-toggle', 'x');
    wireToggle('y-scale-toggle', 'y');
    wireRange('x-min', 'xMin'); wireRange('x-max', 'xMax');
    wireRange('y-min', 'yMin'); wireRange('y-max', 'yMax');
    wireAutoscale('autoscale-btn');
    syncInputs();

    // Line width slider — live update on drag
    const lwSlider = $('line-width');
    const lwDisp   = $('line-width-disp');
    if (lwSlider) {
      lwSlider.value = state.lineWidth;
      if (lwDisp) lwDisp.textContent = state.lineWidth + 'px';
      lwSlider.addEventListener('input', () => {
        state.lineWidth = parseFloat(lwSlider.value);
        if (lwDisp) lwDisp.textContent = state.lineWidth + 'px';
        render();
      });
    }

    // Responsive resize
    window.addEventListener('resize', () => Plotly.Plots.resize(state.plotDiv));

    render();
  };

  window.obieAddTrace = function (x, y, name) {
    const color = PALETTE[traces.length % PALETTE.length];
    traces.push({ x: Array.from(x || []), y: Array.from(y || []), name: name || 'trace', color });
    renderFileList();
    render();
  };

  window.obieClearPlot = function () {
    traces = [];
    renderFileList();
    render();
  };

  window.obieSetBands = function (bands) {
    // bands: JS array of {label, f_lo, f_hi, avg_db, centroid}
    bands = Array.from(bands);
    bandShapes = [];
    bandTraces = [];

    bands.forEach((b, i) => {
      const c = BAND_COLORS[i % BAND_COLORS.length];

      // Shaded region
      bandShapes.push({
        type: 'rect', xref: 'x', yref: 'paper',
        x0: b.f_lo, x1: b.f_hi, y0: 0, y1: 1,
        fillcolor: c, opacity: 0.12, line: { width: 0 },
      });

      // Centroid vertical dashed line
      bandShapes.push({
        type: 'line', xref: 'x', yref: 'paper',
        x0: b.centroid, x1: b.centroid, y0: 0, y1: 1,
        line: { color: c, width: 1.5, dash: 'dot' },
      });

      // Average dB horizontal line across band
      bandTraces.push({
        x: [b.f_lo, b.f_hi], y: [b.avg_db, b.avg_db],
        type: 'scatter', mode: 'lines',
        line: { color: c, width: 2.5 },
        showlegend: false,
        hovertemplate: `<b>${b.label}</b><br>Avg: ${b.avg_db.toFixed(1)} dB<extra></extra>`,
      });

      // Centroid marker
      bandTraces.push({
        x: [b.centroid], y: [b.avg_db],
        type: 'scatter', mode: 'markers',
        marker: { color: c, size: 10, line: { color: 'white', width: 1.5 } },
        showlegend: false,
        hovertemplate: `<b>${b.label}</b><br>Centroid: ${b.centroid.toFixed(0)} Hz<extra></extra>`,
      });
    });

    render();
    _renderBandTable(bands);
  };

  window.obieClearBands = function () {
    bandShapes = [];
    bandTraces = [];
    render();
    _renderBandTable([]);
  };
})();
