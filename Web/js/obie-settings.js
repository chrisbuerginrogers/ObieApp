/**
 * obie-settings.js — Shared ObieAppSettings folder management + cross-tool
 * folder-handle persistence via IndexedDB.
 *
 * Exposes functions used by Acquire, Explore, and Convolve:
 *
 *   const { settingsHandle, templatesHandle, bandsHandle, colorsHandle }
 *         = await openObieAppSettings(dirHandle);
 *
 * ObieAppSettings structure:
 *   ObieAppSettings/
 *     acquire.json       — Acquire preferences
 *     explore.json       — Explore preferences
 *     Templates/         — measurement templates (.json)
 *     bands/             — band-averaging filter files (*_filter.txt)
 *     colors/            — colour-palette files (*_colors.txt)
 *
 * If ObieAppSettings does not yet exist, the folder is created and seeded
 * with default templates and band files fetched from GitHub.
 */

// ── Shared IndexedDB for cross-tool data-folder persistence ──────────────────
const _OBIE_IDB = (() => {
  let _db = null;
  function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open('ObieWebApp', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
      req.onsuccess  = e => { _db = e.target.result; res(_db); };
      req.onerror    = e => rej(e.target.error);
    });
  }
  return {
    async put(key, val) {
      const db = await _open();
      return new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
      });
    },
    async get(key) {
      const db = await _open();
      return new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(key);
        req.onsuccess = () => res(req.result ?? null);
        req.onerror   = e => rej(e.target.error);
      });
    },
  };
})();

async function saveDataFolderHandle(handle) {
  try {
    await _OBIE_IDB.put('dataFolderHandle', handle);
    localStorage.setItem('obieDataFolderName', handle.name);
  } catch (e) { console.warn('saveDataFolderHandle:', e); }
}

async function loadDataFolderHandle() {
  try { return await _OBIE_IDB.get('dataFolderHandle'); }
  catch (_) { return null; }
}

// ── Version tooltip (OBIE_VERSION defined in version.js, loaded before this) ──

document.addEventListener('DOMContentLoaded', () => {
  const brand = document.querySelector('a.brand');
  if (brand && typeof OBIE_VERSION !== 'undefined')
    brand.title = `ObieWebApp v${OBIE_VERSION}`;
});

// ── Seed content ──────────────────────────────────────────────────────────────

const _GH_BASE = 'https://raw.githubusercontent.com/chrisbuerginrogers/ObieApp/main/Python/DefaultSettings/ObieAppSettings/';

const _TEMPLATE_SEEDS = [
  ['HV 24 Obie Rig.json', {
    name: 'HV 24 Obie Rig',
    description: 'Mackie Onyx Producer 2.2 · Behringer ECM 8000 at 20 cm',
    notes: 'Instrument info:\n\n\nTemplate: HV 24  Obie 26\n\nMeasured at: \n\nMic: Behringer ECM 8000 at 20 cm\nSoundcard:  Mackie Onyx Producer 2.2',
    settings: {
      threshold: 0.011, pre_trig_s: 0.001, post_trig_s: 0.30,
      time_cutoff_s: 0.025, mic_time_cutoff_s: 0.25,
      taps: 5, positions: 12, prefix: 'H',
      ham_cal: 1.0, mic_cal: 1.0, swap_channels: false,
      db_spread: 40, db_offset: 0, bit_depth: 24, sample_rate: 48000,
    },
  }],
  ['ScratchPad.json', {
    name: 'ScratchPad',
    description: 'Quick scratch session (JC Studios, Octocapture)',
    notes: 'Instrument info:\n\nMeasured in JC Studios anechoic\n\nHV 24\nJosephson omni mic at 20 cm\nOctocapture, 5 dB mic 20.5 dB hammer',
    settings: {
      threshold: 0.197, pre_trig_s: 0.001, post_trig_s: 0.30,
      time_cutoff_s: 0.006, mic_time_cutoff_s: 0.25,
      taps: 5, positions: 7, prefix: 'H',
      ham_cal: 50.0, mic_cal: 10.0, swap_channels: false,
      db_spread: 30, db_offset: 0, bit_depth: 32, sample_rate: 51200,
    },
  }],
  ['Scratchpad Obie 26.json', {
    name: 'Scratchpad Obie 26',
    description: 'Obie 26 Thor hammer · Behringer ECM 8000 at 20 cm',
    notes: 'Instrument info:\n\n\nMic:  Behringer ECM 8000 mic at 20 cm.\nMic distance: 20 cm.\nHammer: Obie 26 Thor',
    settings: {
      threshold: 0.011, pre_trig_s: 0.001, post_trig_s: 0.30,
      time_cutoff_s: 0.019, mic_time_cutoff_s: 0.30,
      taps: 10, positions: 1, prefix: 'H',
      ham_cal: 1.0, mic_cal: 1.0, swap_channels: false,
      db_spread: 35, db_offset: 0, bit_depth: 24, sample_rate: 48000,
    },
  }],
];

const _GH_SAMPLES = 'https://raw.githubusercontent.com/chrisbuerginrogers/ObieApp/main/Python/DefaultSettings/Test_Samples/';

const _BAND_SEEDS = [
  ['1 flat (200-7000).json',
    _GH_BASE + 'bands/1%20flat%20(200-7000).json'],
  ['2 JC vln 4 band (200-780-1740-2930-7000).json',
    _GH_BASE + 'bands/2%20JC%20vln%204%20band%20(200-780-1740-2930-7000).json'],
  ['3 JC vln 5 band (200-780-1740-3000-5200-7000).json',
    _GH_BASE + 'bands/3%20JC%20vln%205%20band%20(200-780-1740-3000-5200-7000).json'],
  ['4 JC vla 4 band (200-650-1500-2700-6300).json',
    _GH_BASE + 'bands/4%20JC%20vla%204%20band%20(200-650-1500-2700-6300).json'],
  ['Bark (200-9500).json',
    _GH_BASE + 'bands/Bark%20(200-9500).json'],
];

const _COLOR_SEEDS = [
  ['JC 5_colors.json',     _GH_BASE + 'colors/JC%205_colors.json'],
  ['Kelly 24_colors.json', _GH_BASE + 'colors/Kelly%2024_colors.json'],
];

const _LIST_SEEDS = [
  ['Two Strads.json', _GH_BASE + 'lists/Two%20Strads.json'],
];

const _TEST_SAMPLE_SEEDS = [
  ['JacksonStrad H.AvC', _GH_SAMPLES + 'JacksonStrad%20H.AvC'],
  ['Titian Strad H.AvC', _GH_SAMPLES + 'Titian%20Strad%20H.AvC'],
];

async function _seedFiles(dirHandle, seeds) {
  for (const [name, urlOrObj] of seeds) {
    try {
      let content;
      if (typeof urlOrObj === 'string') {
        const r = await fetch(urlOrObj);
        if (!r.ok) continue;
        content = await r.arrayBuffer();
      } else {
        content = JSON.stringify(urlOrObj, null, 2);
      }
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w  = await fh.createWritable();
      await w.write(content);
      await w.close();
    } catch (e) { console.warn('ObieAppSettings seed failed for', name, e); }
  }
}

/**
 * Open (or create) ObieAppSettings inside the given data-folder handle.
 * Creates Templates/, bands/, and colors/ subdirectories.
 * If newly created, seeds Templates/ and bands/ from GitHub.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {{ settingsHandle, templatesHandle, bandsHandle, colorsHandle, listsHandle }}
 */
async function openObieAppSettings(dirHandle) {
  let settingsHandle;
  let isNew = false;

  try {
    settingsHandle = await dirHandle.getDirectoryHandle('ObieAppSettings');
  } catch (_) {
    settingsHandle = await dirHandle.getDirectoryHandle('ObieAppSettings', { create: true });
    isNew = true;
  }

  const templatesHandle = await settingsHandle.getDirectoryHandle('Templates', { create: true });
  const bandsHandle     = await settingsHandle.getDirectoryHandle('bands',     { create: true });
  const colorsHandle    = await settingsHandle.getDirectoryHandle('colors',    { create: true });
  const listsHandle     = await settingsHandle.getDirectoryHandle('lists',     { create: true });

  if (isNew) {
    await _seedFiles(templatesHandle, _TEMPLATE_SEEDS);
    await _seedFiles(bandsHandle,     _BAND_SEEDS);
    await _seedFiles(colorsHandle,    _COLOR_SEEDS);
    await _seedFiles(listsHandle,     _LIST_SEEDS);
    const samplesHandle = await dirHandle.getDirectoryHandle('Test_Samples', { create: true });
    await _seedFiles(samplesHandle, _TEST_SAMPLE_SEEDS);
  }

  return { settingsHandle, templatesHandle, bandsHandle, colorsHandle, listsHandle, isNew };
}
