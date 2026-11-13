import { registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { normalizeTags } from './tags.js';
import { mhtmlHashId } from './urlutil.js';
import { createMerge } from './merge.js';
import { createDupes } from './dupes.js';

// Saját natív plugin (android-extra/BmPlugin.java). A __MOCK_BM__ csak az automatikus tesztekhez van.
const BM = window.__MOCK_BM__ || registerPlugin('BmNative');

const VERSION = 'v3.1';
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const errText = e => (e && (e.message || e.errorMessage)) || String(e);

const DEFAULT_DB = '/storage/emulated/0/Norbi/bookmarks.db';
const DEFAULT_MHTML = '/storage/emulated/0/Norbi/BM-manager/MHTML';
const DEFAULT_MERGE_DIR = '/storage/emulated/0/Norbi/Osszevonas';

$('ver').textContent = VERSION;
document.title = 'BM Mobil ' + VERSION;

// ── állapot ─────────────────────────────────────────────────────────────────────
let dbOpen = false, dbPath = '';
let allIds = [], idx = 0, cur = null;          // a lista csak azonosítókat tárol, a cikk külön töltődik
let viewMode = 'normal';                       // normal | later | pending | protected | missing
let sortMode = 'random';                       // random | idasc | iddesc
let lastAction = null, searchTimer = null, renderTok = 0, statsTok = 0;
let rowsVisible = true, tagsExpanded = true;
let pendingShare = null;                       // megosztott szöveg, ami DB megnyitására vár
let allTagsCache = null, allTagsLoading = null, cmapCache = null;
let allTagCounts = new Map();                  // kisbetűs alak → [megjelenített alak, darab]
const modalStack = [];

// ── tárolás (csak az eszközön) ──────────────────────────────────────────────────
const lsGet = (k, d = '') => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* nincs tárhely */ } };
const lsDel = k => { try { localStorage.removeItem(k); } catch { /* nincs tárhely */ } };
const getDbPath = () => lsGet('bm_db_path', '') || DEFAULT_DB;
const getMhtmlDir = () => (lsGet('bm_mhtml_base_path', '') || DEFAULT_MHTML).replace(/\/+$/, '');

// ── segédek ─────────────────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
let toastTimer;
function toast(msg, ms = 2500) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
const fmt = n => Number(n || 0).toLocaleString('hu-HU');
const pad = n => String(n).padStart(2, '0');

// ── adatbázis-segédek (natív SQLite) ────────────────────────────────────────────
async function qRows(sql, params = []) { return (await BM.query({ sql, params })).rows || []; }
async function qIds(sql, params = []) { return (await BM.query({ sql, params, flat: true })).values || []; }
async function qVal(sql, params = []) { const r = await qRows(sql, params); return r.length ? r[0][0] : null; }
const run = (sql, params = []) => BM.run({ sql, params });

const PEND_NONE = "(pending_delete IS NULL OR pending_delete = '')";
const PEND_SOME = "(pending_delete IS NOT NULL AND pending_delete != '')";

async function ensureColumns() {
  const cols = await qRows('PRAGMA table_info(bookmarks)');
  if (!cols.length) return;
  const names = cols.map(r => r[1]);
  const add = [
    ['is_read', 'INTEGER DEFAULT 0'], ['pending_delete', "TEXT DEFAULT ''"],
    ['protected', 'INTEGER DEFAULT 0'], ['note', "TEXT DEFAULT ''"], ['local_path', "TEXT DEFAULT ''"],
  ];
  for (const [n, def] of add) {
    if (!names.includes(n)) { try { await BM.exec({ sql: `ALTER TABLE bookmarks ADD COLUMN ${n} ${def}` }); } catch { /* nem végzetes */ } }
  }
}

// ── engedély + adatbázis megnyitása ─────────────────────────────────────────────
async function refreshPerm() {
  const box = $('perm-box');
  let granted = false;
  try {
    const i = await BM.info();
    granted = !!i.granted;
    box.className = 'box ' + (granted ? 'ok' : 'no');
    box.textContent = granted ? 'Fájlkezelési engedély: megvan ✔' : 'A „Minden fájl kezelése" engedély hiányzik ✘';
  } catch (e) {
    box.className = 'box no';
    box.textContent = 'Az engedély állapota nem kérdezhető le: ' + errText(e);
  }
  $('perm-btn').style.display = granted ? 'none' : '';
  return granted;
}

function setDbLabel(txt) { $('db-lbl').textContent = txt; }

async function openDatabase(path, quiet) {
  try {
    if (!(await refreshPerm())) {
      dbOpen = false; setDbLabel('Nincs fájlkezelési engedély');
      if (!quiet) toast('⚠️ Előbb add meg a fájlkezelési engedélyt', 3500);
      return false;
    }
    const r = await BM.openDb({ path });
    await ensureColumns();
    dbOpen = true; dbPath = path; allTagsCache = null; allTagsLoading = null; cmapCache = null; lastAction = null;
    setDbLabel(`${path.split('/').pop()} · ${(r.size / 1048576).toFixed(1)} MB`);
    $('db-btn').textContent = '🔄 DB';
    await loadRecords();
    updateStats();
    toast('✅ Megnyitva: ' + path.split('/').pop());
    if (pendingShare) { const d = pendingShare; pendingShare = null; handleShared(d); }
    return true;
  } catch (e) {
    dbOpen = false; setDbLabel('Az adatbázis nem nyitható meg');
    allIds = []; cur = null; renderCard();
    toast('❌ ' + errText(e), 5000);
    return false;
  }
}

// ── modálok + Android vissza gomb ──────────────────────────────────────────────
function showModal(id) {
  if (!modalStack.includes(id)) modalStack.push(id);
  $(id).classList.add('show');
}
function closeModal(id) {
  $(id).classList.remove('show');
  const i = modalStack.indexOf(id); if (i >= 0) modalStack.splice(i, 1);
  if (id === 'dup-modal-overlay') dupClosed();
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); }));

let lastBack = 0;
function handleBack() {
  if (modalStack.length) { closeModal(modalStack[modalStack.length - 1]); return; }
  const now = Date.now();
  if (now - lastBack < 2000) { try { CapApp.exitApp(); } catch { /* böngészőben nincs */ } return; }
  lastBack = now; toast('Nyomd meg még egyszer a kilépéshez', 2000);
}
window.__bmBack = handleBack;                 // a teszteléshez
try { CapApp.addListener('backButton', handleBack); } catch { /* böngészőben nincs Vissza gomb */ }

// ── sorok és címkék elrejtése ──────────────────────────────────────────────────
function applyRows() {
  $('nav-row').style.display = rowsVisible ? '' : 'none';
  $('mode-row').style.display = rowsVisible ? '' : 'none';
  $('toggle-rows-btn').textContent = rowsVisible ? '▲' : '▼';
}
$('toggle-rows-btn').onclick = () => { rowsVisible = !rowsVisible; applyRows(); lsSet('bm_rows_visible', rowsVisible ? '1' : '0'); };

$('tags-toggle-btn').onclick = () => {
  tagsExpanded = !tagsExpanded;
  $('card-tags').style.display = tagsExpanded ? 'flex' : 'none';
  $('tags-toggle-btn').textContent = tagsExpanded ? '▲' : '▼';
};

// ── témaváltó ───────────────────────────────────────────────────────────────────
$('theme-btn').onclick = () => {
  const light = document.body.classList.toggle('light');
  $('theme-btn').textContent = light ? '☀️' : '🌙';
  lsSet('bm_mobil_theme', light ? 'light' : 'dark');
};

// ── színek ──────────────────────────────────────────────────────────────────────
const COLOR_DEFAULTS = { navIcon: '#9aa0b8', tagChip: '#9aa0b8', domainChip: '#4a9eff', dateChip: '#6b7289', noteColor: '#4a9eff', urlColor: '#9aa0b8', statsColor: '#9aa0b8' };
const COLOR_INPUT_MAP = { nav: 'navIcon', tag: 'tagChip', domain: 'domainChip', date: 'dateChip', note: 'noteColor', url: 'urlColor', stats: 'statsColor' };
function getStoredColors() {
  try { return Object.assign({}, COLOR_DEFAULTS, JSON.parse(lsGet('bm_mobil_colors', '{}'))); }
  catch { return { ...COLOR_DEFAULTS }; }
}
function applyColors(c) {
  const r = document.documentElement.style;
  r.setProperty('--nav-icon-color', c.navIcon);
  r.setProperty('--tag-chip-color', c.tagChip);
  r.setProperty('--domain-chip-color', c.domainChip);
  r.setProperty('--date-chip-color', c.dateChip);
  r.setProperty('--note-color', c.noteColor);
  r.setProperty('--url-color', c.urlColor);
  r.setProperty('--stats-color', c.statsColor);
}
const HEX = /^#[0-9a-fA-F]{6}$/;
Object.keys(COLOR_INPUT_MAP).forEach(k => {
  $('col-' + k).addEventListener('input', () => { const v = $('col-' + k).value.trim(); if (HEX.test(v)) $('prev-' + k).style.background = v; });
});

async function showSettings() {
  $('mhtml-path-input').value = lsGet('bm_mhtml_base_path', '') || DEFAULT_MHTML;
  const c = getStoredColors();
  Object.entries(COLOR_INPUT_MAP).forEach(([k, key]) => { $('col-' + k).value = c[key]; $('prev-' + k).style.background = c[key]; });
  $('mhtml-result').style.display = 'none';
  showModal('color-modal-overlay');
  await refreshPendingCount();
  refreshMhtmlSummary();
}
$('btn-colors').onclick = showSettings;
$('color-apply-btn').onclick = () => {
  const c = {};
  Object.entries(COLOR_INPUT_MAP).forEach(([k, key]) => { const v = $('col-' + k).value.trim(); c[key] = HEX.test(v) ? v : COLOR_DEFAULTS[key]; });
  lsSet('bm_mobil_colors', JSON.stringify(c)); applyColors(c); closeModal('color-modal-overlay'); toast('🎨 Színek mentve!');
};
$('color-reset-btn').onclick = () => {
  lsDel('bm_mobil_colors'); applyColors(COLOR_DEFAULTS);
  Object.entries(COLOR_INPUT_MAP).forEach(([k, key]) => { $('col-' + k).value = COLOR_DEFAULTS[key]; $('prev-' + k).style.background = COLOR_DEFAULTS[key]; });
  toast('↩ Alapértelmezett színek visszaállítva');
};
$('mhtml-path-save').onclick = () => {
  const v = $('mhtml-path-input').value.trim().replace(/\/+$/, '');
  if (v && v !== DEFAULT_MHTML) lsSet('bm_mhtml_base_path', v); else lsDel('bm_mhtml_base_path');
  toast('✅ MHTML mappa mentve'); refreshMhtmlSummary(); refreshOpenBtn(cur);
};

// ── 📄 MHTML-lista a Vivaldi MHTML Mentőnek ────────────────────────────────────
// Csak a 🔐 védett cikkek (azok biztosan megtartandók). Sor: azonosító|dátum|cím|webcím. Hogy mi van már lementve, azt kizárólag
// a mappában lévő fájlok mutatják (…_id<azonosító>_… vagy a Hír-Radarból exportáltaknál …_idHR<kód>_…).
const MHTML_COND = `protected = 1 AND ${PEND_NONE}`;
let mhtmlRows = [], mhtmlHave = {}, mhtmlNoUrl = 0;
const mhtmlHas = r => !!(mhtmlHave[String(r.id)] || mhtmlHave[r.hid]);
const mhtmlWanted = () => ($('mhtml-only-missing').checked ? mhtmlRows.filter(r => !mhtmlHas(r)) : mhtmlRows);
function paintMhtmlSummary() {
  const miss = mhtmlRows.filter(r => !mhtmlHas(r)).length, n = mhtmlWanted().length;
  $('mhtml-summary').innerHTML = `🔐 védett cikk: <b>${fmt(mhtmlRows.length)}</b> · offline már megvan: <b>${fmt(mhtmlRows.length - miss)}</b> · még nincs: <b>${fmt(miss)}</b>` +
    `<br>A listába kerül: <b>${fmt(n)}</b> cikk` + (mhtmlNoUrl ? `<br>⚠️ webcím nélküli védett cikk (kimarad): ${fmt(mhtmlNoUrl)}` : '');
  $('mhtml-list-btn').disabled = !n;
}
async function refreshMhtmlSummary() {
  if (!dbOpen) { $('mhtml-summary').textContent = 'Nincs megnyitott adatbázis'; $('mhtml-list-btn').disabled = true; return; }
  $('mhtml-summary').textContent = 'Számolás…';
  try {
    const rows = await qRows(`SELECT id, url, title, add_date FROM bookmarks WHERE ${MHTML_COND} ORDER BY add_date, id`);
    mhtmlNoUrl = rows.filter(r => !String(r[1] || '').trim()).length;
    mhtmlRows = rows.filter(r => String(r[1] || '').trim()).map(([id, url, title, date]) => ({ id, url: String(url).trim(), title: title || '', date: date || '', hid: mhtmlHashId(url) }));
    const keys = []; for (const r of mhtmlRows) { keys.push(String(r.id), r.hid); }
    const r = await BM.findMhtmlMany({ dir: getMhtmlDir(), ids: keys, refresh: true }).catch(() => null);
    mhtmlHave = (r && r.found) || {};
    paintMhtmlSummary();
    if (r && r.exists === false) $('mhtml-summary').innerHTML += '<br>⚠️ Az MHTML mappa nem létezik – minden cikk „még nincs mentve"-nek számít.';
  } catch (e) { $('mhtml-summary').textContent = '❌ ' + errText(e); }
}
$('mhtml-only-missing').onchange = paintMhtmlSummary;
$('mhtml-list-btn').onclick = async () => {
  const rows = mhtmlWanted();
  if (!rows.length) { toast('Nincs mit kiírni'); return; }
  const clean = t => String(t).replace(/[|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const text = rows.map(r => `${r.id}|${r.date}|${clean(r.title)}|${r.url}`).join('\n') + '\n';
  const d = new Date();
  const path = `${dirOf(dbPath)}/mhtml_lista_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
  try {
    await BM.writeText({ path, text });
    const box = $('mhtml-result'); box.style.display = '';
    box.innerHTML = `✅ Kiírva: <b>${fmt(rows.length)}</b> cikk<br><span class="mono">${esc(path)}</span><br>Töltsd be a Vivaldi MHTML Mentő bővítményben.`;
    toast(`📄 Lista kiírva (${fmt(rows.length)} cikk)`, 3500);
  } catch (e) { toast('❌ ' + errText(e), 5000); }
};

// ── összes törlésre jelölt törlése ─────────────────────────────────────────────
const PEND_DELETABLE = `${PEND_SOME} AND (protected IS NULL OR protected != 1)`;
async function refreshPendingCount() {
  const btn = $('del-all-pending-btn');
  if (!dbOpen) { btn.textContent = '🗑 Összes törlésre jelölt törlése'; btn.disabled = true; return; }
  try {
    const n = await qVal(`SELECT COUNT(*) FROM bookmarks WHERE ${PEND_DELETABLE}`);
    btn.textContent = `🗑 Összes törlésre jelölt törlése (${fmt(n)})`; btn.disabled = !n;
  } catch { btn.textContent = '🗑 Összes törlésre jelölt törlése'; btn.disabled = false; }
}
$('del-all-pending-btn').onclick = async () => {
  if (!dbOpen) { toast('⚠️ Nincs megnyitott adatbázis'); return; }
  try {
    const n = await qVal(`SELECT COUNT(*) FROM bookmarks WHERE ${PEND_DELETABLE}`);
    if (!n) { toast('Nincs törlésre jelölt cikk'); return; }
    if (!confirm(`Véglegesen törlöd mind a ${fmt(n)} törlésre jelölt cikket?\n\nEz nem vonható vissza.`)) return;
    const r = await run(`DELETE FROM bookmarks WHERE ${PEND_DELETABLE}`);
    lastAction = null; allTagsCache = null;
    toast(`🗑 Véglegesen törölve: ${fmt(r.changes)} cikk`, 3500);
    await loadRecords(); updateStats(); refreshPendingCount();
  } catch (e) { toast('❌ ' + errText(e), 4000); }
};

// ── rekordok betöltése: csak azonosítók ─────────────────────────────────────────
function loadFlags() {
  return {
    q: $('search-input').value.trim(),
    tags: $('chk-tags').checked, title: $('chk-title').checked, domain: $('chk-domain').checked,
    date: $('chk-date').checked, id: $('chk-id').checked, url: $('chk-url').checked, word: $('chk-word').checked,
  };
}
const MISS_COND = {
  tags: "(custom_tags IS NULL OR TRIM(custom_tags) = '')",
  note: "(note IS NULL OR note = '' OR TRIM(SUBSTR(note, 1, 200)) = '')",
  title: "(title IS NULL OR TRIM(title) = '')",
  date: "(add_date IS NULL OR TRIM(add_date) = '')",
};
function getMissingSel() {
  try { return Object.assign({ tags: true, note: false, title: false, date: false, logic: 'or' }, JSON.parse(lsGet('bm_missing_sel', '{}'))); }
  catch { return { tags: true, note: false, title: false, date: false, logic: 'or' }; }
}

function missWhere() {
  const s = getMissingSel();
  const parts = ['tags', 'note', 'title', 'date'].filter(k => s[k]).map(k => MISS_COND[k]);
  return parts.length ? '(' + parts.join(s.logic === 'and' ? ' AND ' : ' OR ') + ')' : '';
}

function buildWhere() {
  const f = loadFlags();
  const where = [], params = [];
  if (viewMode === 'pending') where.push(PEND_SOME);
  else if (viewMode === 'protected') { where.push(PEND_NONE); where.push('protected = 1'); }
  else if (viewMode === 'later') { where.push(PEND_NONE); where.push('is_read = 1'); }
  else if (viewMode === 'missing') {
    where.push(PEND_NONE);
    const mw = missWhere(); if (mw) where.push(mw);
  } else { where.push(PEND_NONE); where.push('(is_read IS NULL OR is_read = 0)'); }

  if (f.q.length >= 3) {
    if (f.id && /^#?\d+$/.test(f.q)) {
      where.push('id = ?'); params.push(parseInt(f.q.replace('#', ''), 10));
    } else {
      const sub = [], sp = [];
      const lq = f.q.toLowerCase();
      const addS = col => {
        if (f.word) { sub.push(`(' '||LOWER(${col})||' ') LIKE ?`); sp.push(`% ${lq} %`); }
        else { sub.push(`LOWER(${col}) LIKE ?`); sp.push(`%${lq}%`); }
      };
      if (f.tags) addS('custom_tags');
      if (f.title) addS('title');
      if (f.domain) addS('domain');
      if (f.date) addS('add_date');
      if (f.url) addS('url');
      if (sub.length) { where.push('(' + sub.join(' OR ') + ')'); params.push(...sp); }
    }
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

async function loadRecords(focusId) {
  if (!dbOpen) { allIds = []; idx = 0; cur = null; renderCard(); return; }
  const { sql, params } = buildWhere();
  const order = sortMode === 'idasc' ? 'id ASC' : sortMode === 'iddesc' ? 'id DESC' : 'RANDOM()';
  try { allIds = await qIds(`SELECT id FROM bookmarks ${sql} ORDER BY ${order}`, params); }
  catch (e) { allIds = []; toast('❌ ' + errText(e), 4000); }
  idx = 0;
  if (focusId != null) { const p = allIds.indexOf(focusId); if (p >= 0) idx = p; }
  await renderCard();
}

const REC_COLS = 'id, domain, custom_tags, add_date, title, protected, is_read, pending_delete, url, local_path, note';
async function getRecord(id) {
  const rows = await qRows(`SELECT ${REC_COLS} FROM bookmarks WHERE id = ?`, [id]);
  if (!rows.length) return null;
  const r = rows[0];
  return { id: r[0], domain: r[1], custom_tags: r[2], add_date: r[3], title: r[4], protected: r[5], is_read: r[6], pending_delete: r[7], url: r[8], local_path: r[9] || '', note: r[10] || '' };
}

// ── statisztika (két gyors lekérdezés) ──────────────────────────────────────────
// A gombsor számai ugyanazt a feltételt használják, mint a hozzájuk tartozó lista (buildWhere).
function fitModeNums() {
  document.querySelectorAll('#mode-row .mn').forEach(e => e.classList.toggle('long', e.textContent.length >= 7));
}
async function updateStats() {
  if (!dbOpen) return;
  const tok = ++statsTok;
  try {
    const rows = await qRows(`SELECT COUNT(*),
      SUM(CASE WHEN ${PEND_SOME} THEN 1 ELSE 0 END),
      SUM(CASE WHEN protected = 1 AND ${PEND_NONE} THEN 1 ELSE 0 END),
      SUM(CASE WHEN is_read = 1 AND ${PEND_NONE} THEN 1 ELSE 0 END),
      SUM(CASE WHEN ${PEND_NONE} AND (is_read IS NULL OR is_read = 0) THEN 1 ELSE 0 END)
      FROM bookmarks`);
    const mw = missWhere();
    const miss = mw ? await qVal(`SELECT COUNT(*) FROM bookmarks WHERE ${PEND_NONE} AND ${mw}`) : 0;
    if (tok !== statsTok || !rows.length) return;
    const r = rows[0];
    $('stat-total').textContent = fmt(r[0]); $('stat-pend').textContent = fmt(r[1]);
    $('stat-prot').textContent = fmt(r[2]); $('stat-read').textContent = fmt(r[3]); $('stat-live').textContent = fmt(r[4]);
    $('stat-miss').textContent = fmt(miss);
    fitModeNums();
  } catch { /* a statisztika nem kritikus */ }
}

// ── megjelenítés ────────────────────────────────────────────────────────────────
const EMPTY_MSGS = {
  normal: 'Nincs találat.', later: 'Az „Olvasásra vár" lista üres.', pending: 'A „Törlésre vár" lista üres.',
  protected: 'Nincs védett cikk.', missing: 'Nincs olyan cikk, amelyből hiányozna a kijelölt adat.',
};

function showEmpty() {
  $('card-content').style.display = 'none'; $('empty-state').style.display = 'flex';
  $('empty-msg').innerHTML = dbOpen ? esc(EMPTY_MSGS[viewMode] || 'Nincs találat.') : 'Nincs adatbázis megnyitva.<br><br>Koppints a 📂 DB gombra.';
  $('stat-pos').textContent = '–'; $('stat-id').textContent = '–';
}

async function renderCard() {
  const tok = ++renderTok;
  const total = allIds.length;
  if (!total) { cur = null; showEmpty(); return; }
  idx = clamp(idx, 0, total - 1);
  $('stat-pos').textContent = `${idx + 1} / ${fmt(total)}`;
  let rec = null;
  try { rec = await getRecord(allIds[idx]); } catch (e) { toast('❌ ' + errText(e), 4000); }
  if (tok !== renderTok) return;                      // közben újabb kérés indult
  if (!rec) {                                         // időközben kikerült az adatbázisból
    allIds.splice(idx, 1); await renderCard(); return;
  }
  cur = rec; paintCard(rec);
  $('card-area').scrollTop = 0;
}

function paintCard(r) {
  $('card-content').style.display = 'block'; $('empty-state').style.display = 'none';
  $('card-domain').textContent = (r.domain || '–').toUpperCase();
  $('card-date').textContent = r.add_date || '–';

  let si = '';
  if (r.protected == 1) si += '🔒';
  if (r.is_read == 1) si += (si ? ' ' : '') + '📖';
  if (r.pending_delete && r.pending_delete !== '') si += (si ? ' ' : '') + '🗑';
  if (r.local_path && String(r.local_path).trim()) si += (si ? ' ' : '') + '📂';
  $('card-status-icons').textContent = si;
  $('act-open').style.borderColor = (r.local_path && String(r.local_path).trim()) ? 'var(--green)' : '';
  refreshOpenBtn(r);

  const tagsEl = $('card-tags'), tb = $('tags-toggle-btn');
  if (r.custom_tags && String(r.custom_tags).trim()) {
    tagsEl.innerHTML = String(r.custom_tags).split(',').map(t => t.trim()).filter(Boolean).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('');
    tagsEl.style.display = tagsExpanded ? 'flex' : 'none';
    tb.style.display = ''; tb.textContent = tagsExpanded ? '▲' : '▼';
  } else { tagsEl.innerHTML = ''; tagsEl.style.display = 'none'; tb.style.display = 'none'; }

  $('card-title').textContent = r.title || '–';
  const noteEl = $('card-note');
  if (r.note && String(r.note).trim()) { noteEl.textContent = r.note; noteEl.style.display = ''; } else noteEl.style.display = 'none';
  $('card-url').textContent = r.url ? (r.url.length > 120 ? r.url.slice(0, 120) + '…' : r.url) : '';
  $('stat-id').textContent = r.id;
  $('act-prot').classList.toggle('on', r.protected == 1);
  $('act-read').classList.toggle('on', r.is_read == 1);
}

// ── navigáció ───────────────────────────────────────────────────────────────────
function goPrev() { if (!allIds.length) return; idx = (idx - 1 + allIds.length) % allIds.length; renderCard(); }
function goNext() { if (!allIds.length) return; idx = (idx + 1) % allIds.length; renderCard(); }
let txStart = 0, tyStart = 0;
const cardArea = $('card-area');
cardArea.addEventListener('touchstart', e => { txStart = e.touches[0].clientX; tyStart = e.touches[0].clientY; }, { passive: true });
cardArea.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - txStart, dy = e.changedTouches[0].clientY - tyStart;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) { dx < 0 ? goNext() : goPrev(); }
}, { passive: true });
window.__bmNav = { goPrev, goNext };           // a teszteléshez

// ── rendezés: ⬆/⬇ váltó (ID szerint) + véletlen ────────────────────────────────
function paintSortButtons() {
  const b = $('btn-sort');
  b.textContent = sortMode === 'idasc' ? '⬆' : sortMode === 'iddesc' ? '⬇' : '↕';
  b.title = sortMode === 'idasc' ? 'ID szerint növekvő (legkisebb elöl)' : sortMode === 'iddesc' ? 'ID szerint csökkenő (legnagyobb elöl)' : 'Rendezés ID szerint';
  b.className = 'nb' + (sortMode === 'random' ? '' : ' on');
  $('btn-shuffle').className = 'nb' + (sortMode === 'random' ? ' on' : '');
}
$('btn-sort').onclick = () => {
  sortMode = sortMode === 'idasc' ? 'iddesc' : 'idasc';       // az első nyomás mindig a legkisebb ID-vel kezd
  paintSortButtons(); loadRecords();
  toast(sortMode === 'idasc' ? '⬆ ID szerint: a legelső cikk elöl' : '⬇ ID szerint: a legutolsó cikk elöl');
};
$('btn-shuffle').onclick = () => { sortMode = 'random'; paintSortButtons(); loadRecords(); toast('🔀 Összekeverve!'); };

// ── módok ───────────────────────────────────────────────────────────────────────
const modeBtnMap = { missing: 'btn-mode-missing', protected: 'btn-mode-prot', later: 'btn-mode-read', pending: 'btn-mode-del', normal: 'btn-mode-all' };
const modeCls = { missing: 'on-green', protected: 'on-purple', later: 'on-amber', pending: 'on-red', normal: 'on' };
function setMode(mode, focusId) {
  viewMode = mode;
  Object.keys(modeBtnMap).forEach(m => { const b = $(modeBtnMap[m]); b.className = 'nb mb'; if (m === mode) b.classList.add(modeCls[m]); });
  idx = 0; return loadRecords(focusId);
}
$('btn-mode-prot').onclick = () => setMode('protected');
$('btn-mode-read').onclick = () => setMode('later');
$('btn-mode-del').onclick = () => setMode('pending');
$('btn-mode-all').onclick = () => setMode('normal');

// ── hiányzó adat szűrő ─────────────────────────────────────────────────────────
$('btn-mode-missing').onclick = () => {
  const s = getMissingSel();
  $('miss-tags').checked = !!s.tags; $('miss-note').checked = !!s.note; $('miss-title').checked = !!s.title; $('miss-date').checked = !!s.date;
  $('miss-or').checked = s.logic !== 'and'; $('miss-and').checked = s.logic === 'and';
  showModal('missing-modal-overlay');
};
$('miss-apply-btn').onclick = () => {
  const s = { tags: $('miss-tags').checked, note: $('miss-note').checked, title: $('miss-title').checked, date: $('miss-date').checked, logic: $('miss-and').checked ? 'and' : 'or' };
  if (!s.tags && !s.note && !s.title && !s.date) { toast('⚠️ Jelölj be legalább egy mezőt'); return; }
  lsSet('bm_missing_sel', JSON.stringify(s));
  closeModal('missing-modal-overlay'); setMode('missing'); updateStats();
};

// ── keresés ─────────────────────────────────────────────────────────────────────
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (q.length === 0 || q.length >= 3) searchTimer = setTimeout(() => loadRecords(), 350);
});
function updateSearchBtn() {
  const names = [['chk-tags', 'Címkék'], ['chk-title', 'Cím'], ['chk-domain', 'Domain'], ['chk-date', 'Dátum'], ['chk-id', 'ID'], ['chk-url', 'URL']];
  const n = names.filter(([id]) => $(id).checked).map(([, t]) => t);
  const label = n.length ? n.join(', ') : 'Mind';
  $('search-fields-btn').textContent = '🔍 ' + (label.length > 16 ? label.slice(0, 16) + '…' : label) + ' ▾';
  loadRecords();
}
['chk-tags', 'chk-title', 'chk-domain', 'chk-date', 'chk-id', 'chk-url', 'chk-word'].forEach(id => $(id).addEventListener('change', updateSearchBtn));
$('search-fields-btn').onclick = () => showModal('search-modal-overlay');

// ── műveletek ───────────────────────────────────────────────────────────────────
const currentRec = () => (cur && allIds[idx] === cur.id ? cur : null);

async function doProtect() {
  const r = currentRec(); if (!r) return;
  const nv = r.protected == 1 ? 0 : 1;
  try {
    await run('UPDATE bookmarks SET protected = ? WHERE id = ?', [nv, r.id]);
    lastAction = { type: 'protect', id: r.id, old: r.protected };
    r.protected = nv; updateStats(); toast(nv ? '🔒 Védelem beállítva' : '🔓 Védelem levéve'); paintCard(r);
  } catch (e) { toast('❌ ' + errText(e), 4000); }
}
async function doRead() {
  const r = currentRec(); if (!r) return;
  try {
    if (viewMode === 'later') {
      await run('UPDATE bookmarks SET is_read = 0 WHERE id = ?', [r.id]);
      lastAction = { type: 'is_read', id: r.id, old: 1 }; r.is_read = 0; toast('✅ Megtartva – normál listára kerül');
    } else if (viewMode === 'pending') {
      await run("UPDATE bookmarks SET pending_delete = '' WHERE id = ?", [r.id]);
      lastAction = { type: 'pending_delete', id: r.id, old: r.pending_delete }; r.pending_delete = ''; toast('↩ Visszaállítva');
    } else {
      const nv = r.is_read == 1 ? 0 : 1;
      await run('UPDATE bookmarks SET is_read = ? WHERE id = ?', [nv, r.id]);
      lastAction = { type: 'is_read', id: r.id, old: r.is_read }; r.is_read = nv; toast(nv ? '📖 Olvasásra jelölve' : '📖 Jelölés levéve');
    }
    updateStats(); paintCard(r);
  } catch (e) { toast('❌ ' + errText(e), 4000); }
}
async function doDelete() {
  const r = currentRec(); if (!r) return;
  if (r.protected == 1) { toast('⚠️ Védett cikk, nem törölhető!'); return; }
  try {
    if (viewMode === 'pending') {
      if (!confirm('Végleg törlöd?\n\n' + (r.title || r.url || ''))) return;
      await run('DELETE FROM bookmarks WHERE id = ?', [r.id]);
      allIds.splice(idx, 1); if (idx >= allIds.length) idx = Math.max(0, allIds.length - 1);
      lastAction = null; toast('🗑 Végleg törölve'); updateStats(); await renderCard();
    } else {
      const d = new Date(); d.setDate(d.getDate() + 2);
      const ds = d.toISOString().slice(0, 10);
      await run('UPDATE bookmarks SET pending_delete = ? WHERE id = ?', [ds, r.id]);
      lastAction = { type: 'pending_delete', id: r.id, old: '' }; r.pending_delete = ds;
      toast(`🗑 Törlésre jelölve (${ds})`); updateStats(); paintCard(r);
    }
  } catch (e) { toast('❌ ' + errText(e), 4000); }
}
async function doUndo() {
  if (!lastAction) { toast('Nincs visszavonható művelet'); return; }
  const { type, id, old } = lastAction;
  try {
    if (type === 'protect') await run('UPDATE bookmarks SET protected = ? WHERE id = ?', [old, id]);
    else if (type === 'is_read') await run('UPDATE bookmarks SET is_read = ? WHERE id = ?', [old, id]);
    else if (type === 'pending_delete') await run('UPDATE bookmarks SET pending_delete = ? WHERE id = ?', [old || '', id]);
    lastAction = null; updateStats(); toast('↩ Visszavonva');
    if (cur && cur.id === id) await renderCard();
  } catch (e) { toast('❌ ' + errText(e), 4000); }
}
$('act-prot').onclick = doProtect;
$('act-read').onclick = doRead;
$('act-del').onclick = doDelete;
$('btn-undo').onclick = doUndo;

// ── megnyitás: rövid = offline MHTML (ha van), különben web | hosszú (3 mp) = csak web ──────────
// A fájlnévben a cikk azonosítója: …_id123_….mhtml (BM-ből mentett) vagy …_idHR<hash>_….mhtml (a Hír-Radarból exportált cikk,
// az URL-ből számolt kóddal). A mappa tartalma az egyetlen igazság: ami ott van, az offline nyílik.
async function findOfflineFor(rec) {
  if (!rec) return '';
  const keys = [String(rec.id)]; if (rec.url) keys.push(mhtmlHashId(rec.url));
  try {
    const r = await BM.findMhtmlMany({ dir: getMhtmlDir(), ids: keys });
    const f = (r && r.found) || {};
    return f[keys[0]] || (keys[1] && f[keys[1]]) || '';
  } catch { return ''; }
}
let openTok = 0;
async function refreshOpenBtn(r) {
  const t = ++openTok, b = $('act-open');
  b.textContent = '🌐'; b.classList.remove('offline');
  b.title = 'Rövid: web | Hosszú (3mp): csak web';
  if (!r) return;
  const p = await findOfflineFor(r);
  if (t !== openTok || !p) return;
  b.textContent = '📄'; b.classList.add('offline'); b.title = 'Rövid: offline MHTML | Hosszú (3mp): web';
}
async function doOpenWeb() {
  const r = currentRec();
  if (!r || !r.url) { toast('⚠️ Nincs webcím'); return; }
  try { await BM.openUrl({ url: r.url }); } catch (e) { toast('❌ ' + errText(e), 4000); }
}
async function doOpenSmart() {
  const r = currentRec();
  if (!r) { toast('⚠️ Nincs aktuális cikk'); return; }
  const path = await findOfflineFor(r);
  if (path) {
    try { await BM.openFile({ path }); return; }
    catch (e) { toast('⚠️ Az offline fájl nem nyílt meg (' + errText(e) + ') – megnyitom a böngészőben', 4000); }
  }
  doOpenWeb();
}
(function setupOpenBtn() {
  const btn = $('act-open');
  let timer = null, pressed = false, longDone = false;
  const clear = () => { clearTimeout(timer); timer = null; btn.style.transform = ''; };
  btn.addEventListener('pointerdown', () => {
    pressed = true; longDone = false; btn.style.transform = 'scale(0.92)';
    timer = setTimeout(() => { if (!pressed) return; longDone = true; clear(); doOpenWeb(); }, 3000);
  });
  btn.addEventListener('pointerup', () => { const fire = pressed && !longDone; pressed = false; clear(); if (fire) doOpenSmart(); });
  btn.addEventListener('pointercancel', () => { pressed = false; clear(); });
  btn.addEventListener('pointerleave', () => { pressed = false; clear(); });
  btn.addEventListener('contextmenu', e => e.preventDefault());
})();

// ── címkék ──────────────────────────────────────────────────────────────────────
// opcionális tag_case_map.json (a BM tisztító készíti): az adatbázis mappájában
async function getCmap() {
  if (cmapCache) return cmapCache;
  cmapCache = {};
  try {
    const r = await BM.readText({ path: dirOf(dbPath) + '/tag_case_map.json' });
    if (r && r.exists && r.text) {
      const d = JSON.parse(r.text);
      if (d && typeof d === 'object' && !Array.isArray(d)) cmapCache = Object.fromEntries(Object.entries(d).map(([k, v]) => [String(k), String(v)]));
    }
  } catch { /* nincs vagy hibás: alapszabály */ }
  return cmapCache;
}
function dirOf(p) { const i = String(p).lastIndexOf('/'); return i > 0 ? String(p).slice(0, i) : ''; }

async function loadAllTags() {
  if (allTagsCache) return allTagsCache;
  if (!allTagsLoading) {
    allTagsLoading = qIds("SELECT custom_tags FROM bookmarks WHERE custom_tags IS NOT NULL AND custom_tags != ''").then(vals => {
      const cnt = new Map();
      for (const t of vals) {
        if (!t) continue;
        for (let tag of String(t).split(',')) {
          tag = tag.trim(); if (!tag) continue;
          const k = tag.toLowerCase(), e = cnt.get(k);
          if (e) e[1]++; else cnt.set(k, [tag, 1]);
        }
      }
      allTagCounts = cnt;
      allTagsCache = [...cnt.values()].map(e => e[0]).sort((a, b) => a.localeCompare(b, 'hu'));
      return allTagsCache;
    }).finally(() => { allTagsLoading = null; });
  }
  return allTagsLoading;
}

// A javaslatok sorrendje: pontos egyezés; egy szavas címkék (előbb „ezzel kezdődik", utána „tartalmazza");
// végül a többszavas címkék (ugyanígy). Egy csoporton belül a gyakoribb van elöl, utána betűrend.
function rankTags(qs) {
  const exact = [], sStart = [], sCont = [], mStart = [], mCont = [];
  for (const [k, e] of allTagCounts) {
    if (k === qs) { exact.push(e); continue; }
    const single = !/\s/.test(k);
    if (k.startsWith(qs)) (single ? sStart : mStart).push(e);
    else if (k.includes(qs)) (single ? sCont : mCont).push(e);
  }
  const cmp = (a, b) => b[1] - a[1] || a[0].toLowerCase().localeCompare(b[0].toLowerCase(), 'hu');
  for (const g of [sStart, sCont, mStart, mCont]) g.sort(cmp);
  return { exact, hits: [...exact, ...sStart, ...sCont, ...mStart, ...mCont] };
}

const TAG_LIMIT = 400;
let tagSearchTok = 0;
async function updateTagResults() {
  const tok = ++tagSearchTok;
  const q = $('tag-search').value.trim().toLowerCase();
  const box = $('tag-results'), info = $('tag-results-info');
  if (q.length < 3) { box.innerHTML = ''; info.style.display = 'none'; return; }     // 3. karakterig semmit nem mutat
  info.style.display = ''; if (!allTagsCache) info.textContent = 'Címkék betöltése…';
  try { await loadAllTags(); } catch (e) { info.textContent = '❌ ' + errText(e); return; }
  if (tok !== tagSearchTok) return;
  const hits = rankTags(q).hits.map(e => e[0]);
  box.innerHTML = hits.slice(0, TAG_LIMIT).map(t => `<span class="top-tag" data-tag="${esc(t)}">${esc(t)}</span>`).join('');
  info.textContent = hits.length ? `${fmt(hits.length)} találat${hits.length > TAG_LIMIT ? ` (az első ${TAG_LIMIT} látszik – írj még be karaktert)` : ''} – koppints a hozzáadáshoz:` : 'Nincs ilyen címke.';
}
$('tag-search').addEventListener('input', updateTagResults);
$('tag-results').addEventListener('click', e => { const t = e.target.closest('.top-tag'); if (t) addTag(t.dataset.tag); });

// javaslatok a „A cikk címkéi" mezőbe gépelve: az utolsó vesszőig tartó szó 3. karakterétől
const SUG_LIMIT = 40;
let sugTok = 0;
const lastFrag = v => v.slice(v.lastIndexOf(',') + 1).trim();
async function updateTagSuggest() {
  const tok = ++sugTok;
  const box = $('tags-suggest'), info = $('tags-suggest-info');
  const frag = lastFrag($('tags-new-input').value);
  if (frag.length < 3) { box.innerHTML = ''; info.style.display = 'none'; return; }
  info.style.display = ''; if (!allTagsCache) info.textContent = 'Címkék betöltése…';
  try { await loadAllTags(); } catch (e) { info.textContent = '❌ ' + errText(e); return; }
  const cmap = await getCmap().catch(() => null);
  if (tok !== sugTok) return;
  const qs = frag.toLowerCase();
  const { exact, hits } = rankTags(qs);
  const have = new Set($('tags-new-input').value.split(',').slice(0, -1).map(t => t.trim().toLowerCase()));
  const list = hits.map(e => e[0]).filter(t => !have.has(t.toLowerCase()));
  const newForm = normalizeTags(frag, cmap);
  const showNew = newForm && !exact.length && !have.has(newForm.toLowerCase());
  box.innerHTML = list.slice(0, SUG_LIMIT).map(t => `<span class="top-tag" data-tag="${esc(t)}">${esc(t)}</span>`).join('') +
    (showNew ? `<span class="top-tag new-tag" data-new="1" data-tag="${esc(newForm)}">➕ új: ${esc(newForm)}</span>` : '');
  info.textContent = list.length
    ? `${fmt(list.length)} javaslat${list.length > SUG_LIMIT ? ` (az első ${SUG_LIMIT} látszik – írj még be karaktert)` : ''} – koppints a beillesztéshez:`
    : (showNew ? 'Nincs ilyen címke – újként felvehető:' : 'Nincs több javaslat.');
}
$('tags-new-input').addEventListener('input', updateTagSuggest);
$('tags-suggest').addEventListener('click', e => {
  const t = e.target.closest('.top-tag'); if (!t) return;
  const inp = $('tags-new-input');
  const parts = inp.value.split(',').map(x => x.trim());
  parts.pop();                                         // az éppen gépelt töredék helyére kerül a választott címke
  if (!parts.some(x => x.toLowerCase() === t.dataset.tag.toLowerCase())) parts.push(t.dataset.tag);
  inp.value = parts.filter(Boolean).join(', ') + ', ';
  $('tags-suggest').innerHTML = ''; $('tags-suggest-info').style.display = 'none'; sugTok++;
  inp.focus();
});

function addTag(tag) {
  const inp = $('tags-new-input');
  const arr = inp.value.trim() ? inp.value.split(',').map(t => t.trim()).filter(Boolean) : [];
  if (!arr.some(x => x.toLowerCase() === tag.toLowerCase())) { arr.push(tag); inp.value = arr.join(', '); }
}
$('btn-tags-open').onclick = () => {
  const r = currentRec();
  $('tags-article-title').textContent = r ? (r.title || r.url || '') : '';
  $('tags-new-input').value = r ? (r.custom_tags || '') : '';
  $('tag-search').value = ''; $('tag-results').innerHTML = ''; $('tag-results-info').style.display = 'none';
  $('tags-suggest').innerHTML = ''; $('tags-suggest-info').style.display = 'none'; sugTok++;
  showModal('tags-modal-overlay');
  if (dbOpen) loadAllTags().catch(() => { /* a keresésnél kiderül */ });       // háttérben előre betölti
};
$('tags-save-btn').onclick = async () => {
  const r = currentRec(); if (!r) return;
  try {
    const val = normalizeTags($('tags-new-input').value, await getCmap());
    await run('UPDATE bookmarks SET custom_tags = ? WHERE id = ?', [val, r.id]);
    r.custom_tags = val; allTagsCache = null;
    closeModal('tags-modal-overlay'); toast(val ? '✅ Címkék mentve' : '✅ Címkék törölve'); paintCard(r);
  } catch (e) { toast('❌ ' + errText(e), 4000); }
};

// ── DB modal ────────────────────────────────────────────────────────────────────
$('db-btn').onclick = async () => {
  $('db-path-input').value = getDbPath();
  showModal('db-modal-overlay');
  await refreshPerm();
};
$('perm-btn').onclick = async () => {
  try { await BM.openSettings(); toast('Kapcsold be az engedélyt, majd lépj vissza ide.', 4000); }
  catch (e) { toast('A beállítások nem nyithatók meg: ' + errText(e), 4000); }
};
$('db-default-btn').onclick = () => { $('db-path-input').value = DEFAULT_DB; };
$('db-open-btn').onclick = async () => {
  const p = $('db-path-input').value.trim() || DEFAULT_DB;
  lsSet('bm_db_path', p);
  if (await openDatabase(p, false)) closeModal('db-modal-overlay');
};
// Visszatéréskor az engedély-beállításokból: az állapot frissítése
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('db-modal-overlay').classList.contains('show')) refreshPerm(); });

// ── megosztás fogadása (böngésző → Megosztás → BM Mobil) ────────────────────────
function parseShared(d) {
  const text = String(d.text || '');
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  const url = m[0].replace(/[).,;]+$/, '');
  let title = String(d.subject || '').trim();
  if (!title) title = text.replace(m[0], '').replace(/\s+/g, ' ').trim();
  return { url, title };
}
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; } }

function handleShared(d) {
  if (!d || !d.text) return;
  if (!dbOpen) { pendingShare = d; toast('A megosztott linket az adatbázis megnyitása után adom hozzá', 3500); return; }
  const p = parseShared(d);
  if (!p) { toast('⚠️ A megosztott szövegben nincs webcím', 3500); return; }
  $('share-url').value = p.url; $('share-title').value = p.title;
  showModal('share-modal-overlay');
}

async function nowForDb() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  let sample = '';
  try { sample = String(await qVal("SELECT add_date FROM bookmarks WHERE add_date IS NOT NULL AND add_date != '' ORDER BY id DESC LIMIT 1") || ''); } catch { /* alapértelmezett formátum */ }
  if (/^\d{4}-\d{2}-\d{2}T/.test(sample)) return `${date}T${hms}`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(sample)) return `${date} ${hms}`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(sample)) return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return date;
}

$('share-save-btn').onclick = async () => {
  const url = $('share-url').value.trim(), title = $('share-title').value.trim();
  if (!/^https?:\/\//i.test(url)) { toast('⚠️ Érvénytelen webcím'); return; }
  try {
    const dup = await qVal('SELECT id FROM bookmarks WHERE url = ? LIMIT 1', [url]);
    if (dup != null) { closeModal('share-modal-overlay'); toast(`ℹ️ Már szerepel az adatbázisban (ID ${dup})`, 3500); await setMode('normal', dup); return; }
    const vals = { url, title, domain: domainOf(url), add_date: await nowForDb(), custom_tags: '', note: '', protected: 0, is_read: 0, pending_delete: '', local_path: '' };
    const cols = await qRows('PRAGMA table_info(bookmarks)');
    const names = [], params = [];
    for (const [, name, type, notnull, dflt, pk] of cols) {
      if (pk) continue;                                       // az azonosítót az adatbázis adja
      if (name in vals) { names.push(name); params.push(vals[name]); }
      else if (notnull && dflt == null) { names.push(name); params.push(/INT|REAL|NUM|FLOA|DOUB|BOOL/i.test(type || '') ? 0 : ''); }
    }
    const r = await run(`INSERT INTO bookmarks (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, params);
    closeModal('share-modal-overlay');
    toast(`✅ Hozzáadva (ID ${r.id})`, 3000);
    allTagsCache = null; updateStats();
    await setMode('normal', r.id);
  } catch (e) { toast('❌ ' + errText(e), 5000); }
};
window.__bmShare = handleShared;               // a teszteléshez
try { BM.addListener('shared', handleShared); } catch { /* böngészőben nincs */ }
async function checkShared() { try { const d = await BM.getShared(); if (d && d.text) handleShared(d); } catch { /* nincs megosztás */ } }

// ── összevonás másik bookmarks.db-vel ──────────────────────────────────────────
const mergeUi = createMerge({
  $, BM, qRows, qVal, run, toast, fmt, esc, errText, showModal, lsGet, lsSet, lsDel, dirOf, pad,
  defaultDir: DEFAULT_MERGE_DIR, mergeDir: () => lsGet('bm_path_merge', '') || DEFAULT_MERGE_DIR,
  dbPath: () => dbPath, isOpen: () => dbOpen,
  onDone: async () => {
    allTagsCache = null; allTagsLoading = null; cmapCache = null; lastAction = null;
    await ensureColumns(); await loadRecords(); updateStats(); refreshPendingCount();
  },
});
$('merge-open-btn').onclick = () => { if (!dbOpen) { toast('⚠️ Előbb nyisd meg az adatbázist'); return; } closeModal('color-modal-overlay'); mergeUi.open(); };

// ── duplikációk ─────────────────────────────────────────────────────────────────
const dupUi = createDupes({ $, BM, qRows, qVal, run, toast, fmt, esc, errText, showModal, lsGet, lsSet, PEND_NONE, getCmap });
async function dupClosed() {                       // az ablak bezárásakor frissül a lista és a számok, ha töröltünk
  if (!dupUi.isDirty()) return;
  dupUi.clean(); allTagsCache = null; allTagsLoading = null; lastAction = null;
  try { await loadRecords(); updateStats(); refreshPendingCount(); } catch { /* nem végzetes */ }
}
$('dup-open-btn').onclick = () => { if (!dbOpen) { toast('⚠️ Előbb nyisd meg az adatbázist'); return; } closeModal('color-modal-overlay'); dupUi.open(); };

// ── indulás ─────────────────────────────────────────────────────────────────────
(async () => {
  if (lsGet('bm_mobil_theme') === 'light') { document.body.classList.add('light'); $('theme-btn').textContent = '☀️'; }
  if (lsGet('bm_rows_visible') === '0') rowsVisible = false;
  applyRows();
  applyColors(getStoredColors());
  paintSortButtons();
  showEmpty();
  const d = await BM.getShared().catch(() => null);          // a megosztással indított app szövege
  if (d && d.text) pendingShare = d;
  await openDatabase(getDbPath(), true);
  if (!dbOpen) showModal('db-modal-overlay'), $('db-path-input').value = getDbPath();
  else if (pendingShare) { const s = pendingShare; pendingShare = null; handleShared(s); }
})();
