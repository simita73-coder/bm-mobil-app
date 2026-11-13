// BM Mobil – duplikáció-gyanús cikkek keresése és kézi törlése.
// Három keresés (az asztali BM „Duplikáció Kezelő"-jével azonos szabályok): slash eltérés, paraméter eltérés, kombinált.
// Semmit nem töröl magától: a csoportokban soronként, megerősítéssel lehet törölni; a törölt cikk adatai a megmaradónak átadódnak.
import { bmNorm, bmResolve } from './merge.js';

// ── tiszta függvények ───────────────────────────────────────────────────────────
// Python urlparse-szerű széttörés (nem a böngésző URL osztálya: az nem teszi hozzá a végi „/"-t az üres útvonalhoz)
export function splitUrl(u) {
  let s = String(u || '').trim(), frag = '', query = '', scheme = '', netloc = '';
  let i = s.indexOf('#'); if (i >= 0) { frag = s.slice(i + 1); s = s.slice(0, i); }
  i = s.indexOf('?'); if (i >= 0) { query = s.slice(i + 1); s = s.slice(0, i); }
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
  if (s.startsWith('//')) { s = s.slice(2); i = s.search(/[/]/); netloc = i >= 0 ? s.slice(0, i) : s; s = i >= 0 ? s.slice(i) : ''; }
  return { scheme, netloc, path: s, query, frag };
}
// 1. slash eltérés: a végi „/" jelek nélkül azonos
export const keySlash = u => String(u || '').trim().replace(/\/+$/, '');
// 2. paraméter eltérés: a ?paraméterek és a #töredék nélkül, kisbetűvel; YouTube-nál a v= marad
export function keyParam(url) {
  if (!url) return '';
  try {
    const p = splitUrl(url); let q = '';
    if (/youtube\.com|youtu\.be/.test(p.netloc)) {
      const m = /(?:^|&)v=([^&]*)/.exec(p.query); if (m) q = 'v=' + m[1];
    }
    let clean = p.scheme + '://' + p.netloc + p.path;
    if (q) clean += '?' + q;
    if (clean.endsWith('/')) clean = clean.slice(0, -1);
    return clean.toLowerCase();
  } catch { return String(url).toLowerCase(); }
}
// csoportok kulcs szerint: rows = [{id, url, ...}]
export function groupByKey(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    if (!r.url || !String(r.url).trim()) continue;
    const k = keyFn(r.url);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  const out = [];
  for (const g of m.values()) if (g.length > 1) out.push(sortGroup(g));
  return out;
}
const sortGroup = g => g.slice().sort((a, b) => a.url.length - b.url.length || a.id - b.id);
// 3. kombinált: URL szerint rendezve a szomszédok; azonos domain, azonos eleje (prefix karakter), hosszeltérés ≤ lim
export function groupCombined(rows, prefix, lim) {
  const arr = rows.filter(r => r.url).slice().sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : a.id - b.id));
  const groups = []; let cur = null;
  const flush = () => { if (cur && cur.length > 1) groups.push(sortGroup(cur)); cur = null; };
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1];
    const au = a.url.toLowerCase(), bu = b.url.toLowerCase();
    let match = !(!a.domain || a.domain !== b.domain);
    if (match && prefix > 0) {
      if (au.length >= prefix && bu.length >= prefix) { if (au.slice(0, prefix) !== bu.slice(0, prefix)) match = false; }
      else if (au !== bu) match = false;
    }
    if (match && lim > 0 && Math.abs(au.length - bu.length) > lim) match = false;
    if (match) { if (!cur) cur = [a]; cur.push(b); } else flush();
  }
  flush();
  return groups;
}
// az URL-ek közös elejét/végét normálisan, az eltérő középső részt kiemelve adja: [{pre, mid, suf}] – kis/nagybetű számít
export function diffParts(urls) {
  if (urls.length < 2) return urls.map(u => ({ pre: u, mid: '', suf: '' }));
  const minLen = Math.min(...urls.map(u => u.length));
  let P = 0;
  while (P < minLen && urls.every(u => u[P] === urls[0][P])) P++;
  let S = 0;
  while (S < minLen - P && urls.every(u => u[u.length - 1 - S] === urls[0][urls[0].length - 1 - S])) S++;
  return urls.map(u => ({ pre: u.slice(0, P), mid: u.slice(P, u.length - S), suf: u.slice(u.length - S) }));
}
// melyik megmaradó sor kapja a törölt adatait: védett > olvasásra váró > több címke > kisebb azonosító
export function pickSurvivor(rows) {
  const score = r => (r.protected ? 4 : 0) + (r.is_read ? 2 : 0) + (String(r.custom_tags || '').trim() ? 1 : 0);
  return rows.slice().sort((a, b) => score(b) - score(a) || a.id - b.id)[0];
}

// ── felület ─────────────────────────────────────────────────────────────────────
const PAGE = 15;
const DET_COLS = ['id', 'url', 'title', 'domain', 'add_date', 'custom_tags', 'protected', 'is_read', 'category', 'tags', 'status', 'note', 'local_path', 'pending_delete'];

export function createDupes(env) {
  const { $, BM, qRows, qVal, run, toast, fmt, esc, errText, showModal, lsGet, lsSet, PEND_NONE } = env;
  const st = { groups: [], page: 0, kind: '', dirty: false, cols: null, hasLog: null };

  const colsOf = async () => {
    if (st.cols) return st.cols;
    const all = (await qRows('PRAGMA table_info(bookmarks)')).map(r => r[1]);
    st.cols = DET_COLS.filter(c => all.includes(c));
    return st.cols;
  };
  async function loadLight() {                                       // minden nem törlésre váró cikk: azonosító, URL, domain
    const out = []; let last = 0;
    for (;;) {
      const rows = await qRows(`SELECT id, url, domain FROM bookmarks WHERE id > ${Math.trunc(last)} AND ${PEND_NONE} AND COALESCE(url, '') <> '' ORDER BY id LIMIT 5000`);
      if (!rows.length) break;
      for (const [id, url, domain] of rows) out.push({ id, url: String(url), domain: domain == null ? '' : String(domain) });
      last = rows[rows.length - 1][0];
      if (rows.length < 5000) break;
    }
    return out;
  }
  async function loadDetails(ids) {                                  // a megjelenített csoportok sorai
    const cols = await colsOf(); const map = new Map();
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      const rows = await qRows(`SELECT ${cols.join(', ')} FROM bookmarks WHERE id IN (${part.map(() => '?').join(',')})`, part);
      for (const r of rows) { const o = {}; cols.forEach((c, k) => { o[c] = r[k]; }); map.set(o.id, o); }
    }
    return map;
  }

  const rowHtml = (r, parts, same, group) => {
    const tags = String(r.custom_tags || '').trim();
    const badges = (r.protected ? ' 🔐' : '') + (r.is_read ? ' 📖' : '');
    const u = same ? `<span>${esc(r.url)}</span>` : `${esc(parts.pre)}<b class="dd">${esc(parts.mid) || '∅'}</b>${esc(parts.suf)}`;
    return `<div class="dup-row" data-id="${r.id}">
      <div class="dup-head"><span class="dup-id">#${r.id}</span>${badges}<span class="dup-date">${esc(String(r.add_date || '').slice(0, 10))}</span></div>
      <div class="dup-title">${esc(r.title || '(cím nélkül)')}</div>
      ${tags ? `<div class="dup-tags">${esc(tags)}</div>` : ''}
      <div class="dup-url">${u}</div>
      <div class="dup-btns"><button class="dup-open" data-url="${esc(r.url)}">🌐 Megnyitás</button><button class="dup-del" data-id="${r.id}" data-g="${group}">🗑 Törlés</button></div>
    </div>`;
  };
  async function render() {
    const box = $('dup-results'), nav = $('dup-nav'), sum = $('dup-sum');
    const total = st.groups.length, pages = Math.max(1, Math.ceil(total / PAGE));
    st.page = Math.min(st.page, pages - 1);
    const slice = st.groups.slice(st.page * PAGE, st.page * PAGE + PAGE);
    const ids = slice.flatMap(g => g.map(r => r.id));
    const det = ids.length ? await loadDetails(ids) : new Map();
    const arts = st.groups.reduce((a, g) => a + g.length, 0);
    sum.innerHTML = total ? `<b>${fmt(total)}</b> csoport · <b>${fmt(arts)}</b> cikk` : 'Nincs találat.';
    box.innerHTML = slice.map((g, gi) => {
      const rows = g.map(x => det.get(x.id)).filter(Boolean);
      if (rows.length < 2) return '';
      const parts = diffParts(rows.map(r => String(r.url)));
      const same = parts.every(p => p.mid === '' && p.pre === parts[0].pre && p.suf === parts[0].suf);
      return `<div class="dup-group" data-g="${st.page * PAGE + gi}"><div class="dup-gtitle">${same ? '✔ azonos URL' : 'URL-eltérés pirossal'} · ${rows.length} cikk</div>` +
        rows.map((r, i) => rowHtml(r, parts[i], same, st.page * PAGE + gi)).join('') + '</div>';
    }).join('');
    nav.style.display = pages > 1 ? '' : 'none';
    $('dup-page').textContent = `${st.page + 1} / ${pages}`;
    $('dup-prev').disabled = st.page <= 0; $('dup-next').disabled = st.page >= pages - 1;
  }

  async function search(kind) {
    const sum = $('dup-sum'); sum.textContent = 'Keresés…'; $('dup-results').innerHTML = ''; $('dup-nav').style.display = 'none';
    st.kind = kind; st.page = 0;
    try {
      let groups;
      if (kind === 'combined') {
        const prefix = Math.max(0, parseInt($('dup-prefix').value, 10) || 0), lim = Math.max(0, parseInt($('dup-len').value, 10) || 0);
        if (!prefix && !lim) { sum.textContent = 'Legalább az egyik szűrőt állítsd be (Kezdet vagy Hossz eltérés)!'; return; }
        lsSet('bm_dupe_prefix', String(prefix)); lsSet('bm_dupe_len', String(lim));
        groups = groupCombined(await loadLight(), prefix, lim);
      } else groups = groupByKey(await loadLight(), kind === 'slash' ? keySlash : keyParam);
      st.groups = groups;
      $('dup-cnt-' + kind).textContent = ` (${fmt(groups.length)} csoport)`;
      await render();
      sum.scrollIntoView({ block: 'start' });                // a találatokhoz görget
    } catch (e) { sum.textContent = '❌ ' + errText(e); }
  }

  async function hasLog() {
    if (st.hasLog == null) st.hasLog = (await qVal("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'deleted_log'")) > 0;
    return st.hasLog;
  }
  async function deleteRow(id, gIdx) {
    const g = st.groups[gIdx]; if (!g) return;
    const cols = await colsOf();
    const det = await loadDetails(g.map(x => x.id));
    const victim = det.get(id); if (!victim) { toast('⚠️ A cikk már nincs meg'); return; }
    const rest = g.filter(x => x.id !== id).map(x => det.get(x.id)).filter(Boolean);
    if (!rest.length) return;
    const keep = pickSurvivor(rest);
    // a megmaradó megkapja a törölt adatait, ha az többet tud (címkék uniója, védelem, olvasásra jelölés, üres mezők)
    const a = bmNorm(keep), b = bmNorm(victim);
    const rec = bmResolve(a, b, await (env.getCmap ? env.getCmap() : {}));
    const sets = [], params = [];
    for (const c of cols) {
      if (c === 'id' || c === 'url' || c === 'pending_delete') continue;
      if (rec[c] !== a[c]) { sets.push(`${c} = ?`); params.push(rec[c]); }
    }
    const moved = sets.length ? sets.map(s => s.split(' ')[0]).join(', ') : '';
    const msg = `Véglegesen törlöd a #${id} cikket?${victim.protected ? '\n🔐 Ez a cikk védett!' : ''}\n\n${victim.title || victim.url}\n\n` +
      `A #${keep.id} cikk marad` + (moved ? ` – ennek adatai frissülnek (${moved}).` : '.') + '\nEz nem vonható vissza.';
    if (!confirm(msg)) return;
    try {
      if (sets.length) { params.push(keep.id); await run(`UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ?`, params); }
      await run('DELETE FROM bookmarks WHERE id = ?', [id]);
      // a törölt URL csak akkor kerül a deleted_log-ba, ha már egyik megmaradó cikknek sincs ugyanaz az URL-je
      if (victim.url && await hasLog()) {
        const same = await qVal('SELECT COUNT(*) FROM bookmarks WHERE url = ?', [victim.url]);
        if (!same) await run('INSERT OR REPLACE INTO deleted_log (url, deleted_at) VALUES (?, ?)', [victim.url, new Date().toISOString().slice(0, 10)]);
      }
      st.dirty = true;
      st.groups[gIdx] = g.filter(x => x.id !== id);               // az ablakban lévő találati lista frissítése
      if (st.groups[gIdx].length < 2) st.groups.splice(gIdx, 1);
      toast(`🗑 Törölve (#${id})` + (sets.length ? ` – adatok átadva: #${keep.id}` : ''), 3500);
      await render();
    } catch (e) { toast('❌ ' + errText(e), 4000); }
  }

  $('dup-slash').onclick = () => search('slash');
  $('dup-param').onclick = () => search('param');
  $('dup-comb').onclick = () => search('combined');
  $('dup-prev').onclick = () => { st.page--; render(); $('dup-results').scrollIntoView({ block: 'start' }); };
  $('dup-next').onclick = () => { st.page++; render(); $('dup-results').scrollIntoView({ block: 'start' }); };
  $('dup-results').addEventListener('click', e => {
    const o = e.target.closest('.dup-open');
    if (o) { BM.openUrl({ url: o.dataset.url }).catch(err => toast('❌ ' + errText(err), 4000)); return; }
    const d = e.target.closest('.dup-del');
    if (d) deleteRow(Number(d.dataset.id), Number(d.dataset.g));
  });

  return {
    open() {
      $('dup-prefix').value = lsGet('bm_dupe_prefix', '100'); $('dup-len').value = lsGet('bm_dupe_len', '1');
      st.groups = []; st.page = 0; st.dirty = false;
      for (const k of ['slash', 'param', 'combined']) $('dup-cnt-' + k).textContent = '';
      $('dup-sum').textContent = 'Válassz keresést.'; $('dup-results').innerHTML = ''; $('dup-nav').style.display = 'none';
      showModal('dup-modal-overlay');
    },
    isDirty: () => st.dirty,
    clean: () => { st.dirty = false; st.cols = null; st.hasLog = null; },
  };
}
