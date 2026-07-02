/* ─────────────────────────────────────────────────────────────────────
 * plotly-helpers.js
 * Layout factory for the TRF Reader (used by plot-controls.js).
 *
 * Requires: plotly-theme.js loaded first (provides cssVar()).
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Build a Plotly layout from a plot-controls state object.
 * s: { xLabel, yLabel, xLog, yLog, xMin, xMax, yMin, yMax }
 */
window.obieBuildPlotLayout = function (s) {
  function rangeFor(min, max, log) {
    if (min == null || max == null) return undefined;
    if (log) {
      const lo = Math.max(1e-12, min);
      return [Math.log10(lo), Math.log10(Math.max(lo * 1.001, max))];
    }
    return [min, max];
  }
  const border = cssVar('--border');
  const text   = cssVar('--text');
  return {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font:   { color: text, family: 'inherit', size: 12 },
    margin: { l: 70, r: 24, t: 26, b: 56 },
    showlegend: false, autosize: true,
    xaxis: {
      title: s.xLabel || 'X', type: s.xLog ? 'log' : 'linear',
      gridcolor: border, zerolinecolor: border, linecolor: border,
      autorange: !(s.xMin != null && s.xMax != null),
      range: rangeFor(s.xMin, s.xMax, s.xLog),
    },
    yaxis: {
      title: s.yLabel || 'Y', type: s.yLog ? 'log' : 'linear',
      gridcolor: border, zerolinecolor: border, linecolor: border,
      autorange: !(s.yMin != null && s.yMax != null),
      range: rangeFor(s.yMin, s.yMax, s.yLog),
    },
  };
};

window.OBIE_PLOT_CONFIG = {
  responsive: true, displaylogo: false,
  modeBarButtonsToRemove: ['sendDataToCloud'],
};
