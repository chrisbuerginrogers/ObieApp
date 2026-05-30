/**
 * obie-settings.js — Shared ObieAppSettings folder management + cross-tool
 * folder-handle persistence via IndexedDB.
 *
 * Exposes functions used by Acquire, Explore, and Convolve It:
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

// ── Seed content ──────────────────────────────────────────────────────────────

const _GH_BASE = 'https://raw.githubusercontent.com/chrisbuerginrogers/ObieWebApp/main/Python%20Code/ObieApp%20Settings/';

const _TEMPLATE_SEEDS = [
  ['HV 24 Obie Rig_template.json',    _GH_BASE + 'template/HV%2024%20Obie%20Rig_template.json'],
  ['ScratchPad_template.json',         _GH_BASE + 'template/ScratchPad_template.json'],
  ['Scratchpad Obie 26_template.json', _GH_BASE + 'template/Scratchpad%20Obie%2026_template.json'],
];

const _BAND_SEEDS = [
  ['1 flat (200-7000)_filter.txt',
    _GH_BASE + 'filter/1%20flat%20(200-7000)_filter.txt'],
  ['2 JC vln 4 band (200-780-1740-2930-7000)_filter.txt',
    _GH_BASE + 'filter/2%20JC%20vln%204%20band%20%20(200-780-1740-2930-7000)_filter.txt'],
  ['3 JC vln 5 band (200-780-1740-3000-5200-7000)_filter.txt',
    _GH_BASE + 'filter/3%20JC%20vln%205%20band%20(200-780-1740-3000-5200-7000)_filter.txt'],
  ['4 JC vla 4 band (200-650-1500-2700-6300)_filter.txt',
    _GH_BASE + 'filter/4%20JC%20vla%204%20band%20%7B200-650-1500-2700-6300%7D_filter.txt'],
  ['Bark (200-9500)_filter.txt',
    _GH_BASE + 'filter/Bark%20%20(200-300-400-510-630-770-920-1080-1270-1480-1700-2000-2330-3000-3150-3700-4400-5300-6400-7700-9500)_filter.txt'],
];

async function _seedFiles(dirHandle, seeds) {
  for (const [name, url] of seeds) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w  = await fh.createWritable();
      await w.write(await r.text());
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
 * @returns {{ settingsHandle, templatesHandle, bandsHandle, colorsHandle }}
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

  if (isNew) {
    await _seedFiles(templatesHandle, _TEMPLATE_SEEDS);
    await _seedFiles(bandsHandle,     _BAND_SEEDS);
  }

  return { settingsHandle, templatesHandle, bandsHandle, colorsHandle };
}
