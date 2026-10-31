/**
 * obie-settings.js — Shared ObieWebSettings folder management + cross-tool
 * folder-handle persistence via IndexedDB.
 *
 * Exposes functions used by Acquire, Explore, and Convolve:
 *
 *   const { settingsHandle, templatesHandle, bandsHandle, colorsHandle }
 *         = await openObieAppSettings(dirHandle);
 *
 * ObieWebSettings structure:
 *   ObieWebSettings/
 *     acquire.json       — Acquire preferences
 *     explore.json       — Explore preferences
 *     Templates/         — measurement templates (.json)
 *     bands/             — band-averaging filter files (*_filter.txt)
 *     colors/            — colour-palette files (*_colors.txt)
 *
 * If ObieWebSettings does not yet exist, the folder is created and seeded
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

const _GH_BASE = 'https://raw.githubusercontent.com/chrisbuerginrogers/ObieApp/main/Python/DefaultSettings/ObieWebSettings/';

// Templates are fetched directly from Python/DefaultSettings/ObieWebSettings/Templates/
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

// Name of the settings folder inside the Data Folder, and the names it has
// gone by before. The web app used "_ObieAppSettings" and then "ObieAppSettings"
// (the LabVIEW environment still writes the underscore one). Legacy folders are
// merged into the current one. "ObieAppSettings" is removed once everything in
// it is confirmed present in the new folder; "_ObieAppSettings" is left alone
// because LabVIEW still uses it.
const _SETTINGS_DIR_NAME     = 'ObieWebSettings';
const _LEGACY_SETTINGS_DIRS  = ['ObieAppSettings', '_ObieAppSettings'];
const _REMOVE_AFTER_MERGE    = new Set(['ObieAppSettings']);

// Recursively copies any file present in `srcHandle` but missing from
// `destHandle` into destHandle (creating subfolders as needed) — never
// overwrites a file that already exists there. Never touches srcHandle.
async function _mergeMissing(srcHandle, destHandle) {
  for await (const [name, h] of srcHandle.entries()) {
    if (h.kind === 'directory') {
      try {
        const destSub = await destHandle.getDirectoryHandle(name, { create: true });
        await _mergeMissing(h, destSub);
      } catch (e) { console.warn('Legacy settings merge failed for folder', name, e); }
      continue;
    }
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
    } catch (e) { console.warn('Legacy settings merge failed for', name, e); }
  }
}

// True only if every file and folder under `srcHandle` exists under `destHandle`.
async function _allPresent(srcHandle, destHandle) {
  for await (const [name, h] of srcHandle.entries()) {
    try {
      if (h.kind === 'directory') {
        if (!await _allPresent(h, await destHandle.getDirectoryHandle(name))) return false;
      } else {
        await destHandle.getFileHandle(name);
      }
    } catch (_) { return false; }
  }
  return true;
}

// If any legacy settings folder exists alongside the current one, pull forward
// anything missing. Runs on every startup (cheap once in sync). A legacy folder
// listed in _REMOVE_AFTER_MERGE is deleted once the copy is verified complete;
// if anything is missing or removal fails, it is left in place. Returns true if
// at least one legacy folder was found.
async function _mergeLegacySettingsFolders(dirHandle, settingsHandle) {
  let found = false;
  for (const legacyName of _LEGACY_SETTINGS_DIRS) {
    let legacyHandle;
    try {
      legacyHandle = await dirHandle.getDirectoryHandle(legacyName);
    } catch (_) {
      continue;   // this legacy folder doesn't exist
    }
    found = true;

    await _mergeMissing(legacyHandle, settingsHandle);

    if (_REMOVE_AFTER_MERGE.has(legacyName)) {
      try {
        if (await _allPresent(legacyHandle, settingsHandle)) {
          await dirHandle.removeEntry(legacyName, { recursive: true });
        } else {
          console.warn('Legacy', legacyName, 'not fully copied — leaving it in place');
        }
      } catch (e) { console.warn('Could not remove legacy', legacyName, e); }
    }
  }
  return found;
}

async function _seedFiles(dirHandle, seeds) {
  let failures = 0;
  for (const [name, urlOrObj] of seeds) {
    try {
      let content;
      if (typeof urlOrObj === 'string') {
        const r = await fetch(urlOrObj);
        if (!r.ok) { failures++; console.warn('Settings seed HTTP error for', name, r.status); continue; }
        content = await r.arrayBuffer();
      } else {
        content = JSON.stringify(urlOrObj, null, 2);
      }
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w  = await fh.createWritable();
      await w.write(content);
      await w.close();
    } catch (e) { failures++; console.warn('Settings seed failed for', name, e); }
  }
  return failures;
}

/**
 * Open (or create) ObieWebSettings inside the given data-folder handle.
 * Creates Templates/, bands/, colors/ and lists/ subdirectories.
 * If newly created (and no legacy settings folder exists to migrate from),
 * seeds them from GitHub.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {{ settingsHandle, templatesHandle, bandsHandle, colorsHandle, listsHandle }}
 */
async function openObieAppSettings(dirHandle) {
  let settingsHandle;
  let isNew = false;

  try {
    settingsHandle = await dirHandle.getDirectoryHandle(_SETTINGS_DIR_NAME);
  } catch (_) {
    settingsHandle = await dirHandle.getDirectoryHandle(_SETTINGS_DIR_NAME, { create: true });
    isNew = true;
  }

  const templatesHandle = await settingsHandle.getDirectoryHandle('Templates', { create: true });
  const bandsHandle     = await settingsHandle.getDirectoryHandle('bands',     { create: true });
  const colorsHandle    = await settingsHandle.getDirectoryHandle('colors',    { create: true });
  const listsHandle     = await settingsHandle.getDirectoryHandle('lists',     { create: true });

  // Pull forward anything left behind in a legacy settings folder
  // ("ObieAppSettings" / "_ObieAppSettings") that isn't already here — additive
  // only, never overwrites, and runs every time in case a legacy folder gains
  // files later (e.g. from an archived version or LabVIEW). Done BEFORE seeding
  // so the user's own files win over the defaults.
  const migrated = await _mergeLegacySettingsFolders(dirHandle, settingsHandle);

  // A folder migrated from a legacy one is not "new" — the user already has
  // their settings, so don't seed defaults or show the new-folder message.
  if (migrated) isNew = false;

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

  return { settingsHandle, templatesHandle, bandsHandle, colorsHandle, listsHandle, isNew, seedsFailed };
}
