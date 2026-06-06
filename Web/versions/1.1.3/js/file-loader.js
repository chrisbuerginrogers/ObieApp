/* ─────────────────────────────────────────────────────────────────────
 * file-loader.js
 * Reads the chosen file as an ArrayBuffer and passes a Uint8Array
 * directly to the Python onData callback for parsing.
 *
 * Python callback:  onData(filename, sizeBytes, uint8array)
 * ───────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  function readFile(file, cfg) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => cfg.onData(file.name, file.size, null);
    reader.onload  = (e) => {
      cfg.onData(file.name, file.size, new Uint8Array(e.target.result));
    };
    reader.readAsArrayBuffer(file);
  }

  window.obieInitFileLoader = function (cfg) {
    if (!cfg || typeof cfg.onData !== 'function') {
      console.error('obieInitFileLoader: onData callback required');
      return;
    }
    const drop  = document.getElementById(cfg.dropZoneId);
    const pick  = document.getElementById(cfg.pickerBtnId);
    const input = document.getElementById(cfg.fileInputId);

    if (pick && input) {
      pick.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        Array.from(input.files || []).forEach(f => readFile(f, cfg));
      });
    }
    if (drop) {
      drop.addEventListener('click', () => input && input.click());
      ['dragenter','dragover'].forEach(ev =>
        drop.addEventListener(ev, e => {
          e.preventDefault(); drop.classList.add('dragging'); }));
      ['dragleave','drop'].forEach(ev =>
        drop.addEventListener(ev, e => {
          e.preventDefault(); drop.classList.remove('dragging'); }));
      drop.addEventListener('drop', e => {
        Array.from((e.dataTransfer && e.dataTransfer.files) || [])
          .forEach(f => readFile(f, cfg));
      });
    }
  };


})();
