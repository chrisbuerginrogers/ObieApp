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

// Templates are fetched directly from Python/DefaultSettings/ObieAppSettings/Templates/
// on GitHub — that folder is the single source of truth for default content.
const _TEMPLATE_SEEDS = [
  ['HV 24 Obie Rig.json',      _GH_BASE + 'Templates/HV%2024%20Obie%20Rig.json'],
  ['ScratchPad.json',           _GH_BASE + 'Templates/ScratchPad.json'],
  ['Scratchpad Obie 26.json',   _GH_BASE + 'Templates/Scratchpad%20Obie%2026.json'],
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

// Copies any file present in `srcHandle` but missing from `destHandle` into
// destHandle — never overwrites a file that already exists there. Used to pull
// forward files left behind in the pre-rename "_ObieAppSettings" folder
// (older web-app versions, and the LabVIEW environment, both wrote there)
// without ever touching or deleting the legacy folder itself.
async function _mergeMissingFiles(srcHandle, destHandle) {
  for await (const [name, h] of srcHandle.entries()) {
    if (h.kind !== 'file') continue;
    try {
      await destHandle.getFileHandle(name);
      continue;   // already present in the new folder — never overwrite
    } catch (_) { /* not present — copy it over */ }
    try {
      const buf = await (await h.getFile()).arrayBuffer();
      const fh  = await destHandle.getFileHandle(name, { create: true });
      const w   = await fh.createWritable();
      await w.write(buf);
      await w.close();
    } catch (e) { console.warn('Legacy _ObieAppSettings merge failed for', name, e); }
  }
}

// If a legacy "_ObieAppSettings" folder exists alongside the current
// "ObieAppSettings" one, pull forward anything missing — the top-level
// preference files plus every subfolder. Runs on every startup (cheap once
// the two are in sync) so anything later added on the LabVIEW side keeps
// showing up here too. Silent — this is expected to become a no-op quickly.
async function _mergeLegacySettingsFolder(dirHandle, settingsHandle, subHandles) {
  let legacyHandle;
  try {
    legacyHandle = await dirHandle.getDirectoryHandle('_ObieAppSettings');
  } catch (_) {
    return;   // no legacy folder — nothing to do
  }

  await _mergeMissingFiles(legacyHandle, settingsHandle);

  for (const [subName, destHandle] of Object.entries(subHandles)) {
    try {
      const legacySub = await legacyHandle.getDirectoryHandle(subName);
      await _mergeMissingFiles(legacySub, destHandle);
    } catch (_) { /* legacy folder has no such subfolder — nothing to merge */ }
  }
}

async function _seedFiles(dirHandle, seeds) {
  let failures = 0;
  for (const [name, urlOrObj] of seeds) {
    try {
      let content;
      if (typeof urlOrObj === 'string') {
        const r = await fetch(urlOrObj);
        if (!r.ok) { failures++; console.warn('ObieAppSettings seed HTTP error for', name, r.status); continue; }
        content = await r.arrayBuffer();
      } else {
        content = JSON.stringify(urlOrObj, null, 2);
      }
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w  = await fh.createWritable();
      await w.write(content);
      await w.close();
    } catch (e) { failures++; console.warn('ObieAppSettings seed failed for', name, e); }
  }
  return failures;
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

  let seedsFailed = false;
  if (isNew) {
    const f1 = await _seedFiles(templatesHandle, _TEMPLATE_SEEDS);
    const f2 = await _seedFiles(bandsHandle,     _BAND_SEEDS);
    const f3 = await _seedFiles(colorsHandle,    _COLOR_SEEDS);
    const f4 = await _seedFiles(listsHandle,     _LIST_SEEDS);
    const samplesHandle = await dirHandle.getDirectoryHandle('Test_Samples', { create: true });
    const f5 = await _seedFiles(samplesHandle, _TEST_SAMPLE_SEEDS);
    seedsFailed = (f1 + f2 + f3 + f4 + f5) > 0;
  }

  // Pull forward anything left behind in a pre-rename "_ObieAppSettings"
  // folder (older web-app versions and LabVIEW both used that name) that
  // isn't already in the current "ObieAppSettings" — additive only, never
  // overwrites, and runs every time in case the legacy folder gains files later.
  await _mergeLegacySettingsFolder(dirHandle, settingsHandle, {
    Templates: templatesHandle,
    bands:     bandsHandle,
    colors:    colorsHandle,
    lists:     listsHandle,
  });

  return { settingsHandle, templatesHandle, bandsHandle, colorsHandle, listsHandle, isNew, seedsFailed };
}
