// BM Mobil – összevonás egy másik bookmarks.db-vel (asztali vagy másik telefon/tablet).
// A megnyitott adatbázisba ír, a másik fájlt ATTACH-csal csak olvassa; előtte biztonsági másolat készül.
// A cikkek uniója mindkét irányban; közben MINDEN sor címkéi a tag_clean szabályai szerint javulnak.
import { normalizeTags, splitTags } from './tags.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Tiszta szabályfüggvények
// ═══════════════════════════════════════════════════════════════════════════════
const nz = v => (v == null ? '' : String(v));
export function wsNorm(s) { return nz(s).replace(/\xa0/g, ' ').replace(/\s+/g, ' ').trim(); }

const BM_COLS = ['id', 'category', 'title', 'domain', 'url', 'tags', 'custom_tags', 'status', 'add_date', 'protected', 'local_path', 'note', 'is_read', 'pending_delete'];
const BM_TEXT_COLS = ['category', 'title', 'domain', 'tags', 'status', 'add_date'];
const BM_BOOL = ['protected', 'is_read'];
const bmPrio = r => (r.pending_delete ? 3 : (r.is_read ? 2 : 1));

export function bmNorm(o) {
  const r = {};
  for (const c of BM_COLS) {
    if (c === 'id') r.id = o.id;
    else if (BM_BOOL.includes(c)) r[c] = o[c] ? 1 : 0;
    else r[c] = o[c] ? (typeof o[c] === 'string' ? o[c] : String(o[c])) : '';
  }
  return r;
}
export function bmResolveState(a, b) {
  const win = bmPrio(a) >= bmPrio(b) ? a : b;
  const st = { is_read: win.is_read ? 1 : 0, pending_delete: win.pending_delete || '', protected: (a.protected || b.protected) ? 1 : 0 };
  if (st.pending_delete === '') st.pending_delete = a.pending_delete || b.pending_delete || '';
  return st;
}
export function mergeNote(na, nb) {
  na = nz(na); nb = nz(nb);
  if (!nb.trim()) return na;
  if (!na.trim()) return nb;
  if (wsNorm(na) === wsNorm(nb)) return na;           // csak szóköz-eltérés → az elsődleges
  return na.length >= nb.length ? na : nb;
}
// Két címkelista uniója, a tag_clean szabályai szerint tisztítva (a hibás alakokat javítja, nem törli).
export function unionClean(a, b, cmap) {
  return normalizeTags([...splitTags(a), ...splitTags(b)], cmap);
}
// a: az elsődleges oldal sora, b: a másik; mindkettő bmNorm-os
export function bmResolve(a, b, cmap) {
  const rec = { ...a };
  for (const col of [...BM_TEXT_COLS, 'url']) if (!rec[col] && b[col]) rec[col] = b[col];
  rec.custom_tags = unionClean(a.custom_tags, b.custom_tags, cmap);
  rec.note = mergeNote(a.note, b.note);
  rec.local_path = a.local_path || b.local_path || '';
  Object.assign(rec, bmResolveState(a, b));
  return rec;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Összevonás az adatbázisban (SQL + kis JS)
// ═══════════════════════════════════════════════════════════════════════════════
const ATT = 'dsk';                                    // a másik fájl ATTACH-neve
const CHUNK = 1500;
const SCAN = 3000;

export function createMerge(env) {
  const { $, BM, qRows, qVal, run, toast, fmt, esc, errText, showModal, lsSet, lsDel, dirOf, pad, defaultDir } = env;
  const FILE = 'bookmarks.db';
  const st = { dir: '', previewKey: null, running: false, cmap: {}, cmapPath: null };

  const exec = sql => BM.exec({ sql });
  const batchAll = async ops => { for (let i = 0; i < ops.length; i += 1000) await BM.batch({ ops: ops.slice(i, i + 1000) }); };
  const colInfo = async (schema, table) => qRows(`PRAGMA ${schema}.table_info(${table})`);
  const colNames = async (schema, table) => (await colInfo(schema, table)).map(r => r[1]);
  const hasTable = async (schema, name) => (await qVal(`SELECT COUNT(*) FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`, [name])) > 0;

  async function withAttached(path, fn) {
    try { await exec(`DETACH DATABASE ${ATT}`); } catch { /* nincs csatolva – rendben */ }
    await exec(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS ${ATT}`);
    try { return await fn(); }
    finally { try { await exec(`DETACH DATABASE ${ATT}`); } catch { /* nem végzetes */ } }
  }
  async function inTx(fn) {
    await exec('BEGIN');
    let r;
    try { r = await fn(); await exec('COMMIT'); }
    catch (e) { try { await exec('ROLLBACK'); } catch { /* nem végzetes */ } throw e; }
    return r;
  }

  async function findCmap() {
    for (const dir of [st.dir, dirOf(env.dbPath())]) {
      try {
        const r = await BM.readText({ path: dir + '/tag_case_map.json' });
        if (r && r.exists && r.text) {
          const d = JSON.parse(r.text);
          if (d && typeof d === 'object' && !Array.isArray(d)) return { cmap: Object.fromEntries(Object.entries(d).map(([k, v]) => [String(k), String(v)])), path: dir + '/tag_case_map.json' };
        }
      } catch { /* hibás vagy nincs: a következő mappa */ }
    }
    return { cmap: {}, path: null };
  }
  const cmapLine = () => st.cmapPath ? `Címke-szótár: ${st.cmapPath} (${fmt(Object.keys(st.cmap).length)} szó)` : 'Címke-szótár: nincs (tag_case_map.json) – a betűszavakat nagybetűsen hagyja, a többit kisbetűsre javítja';

  // ── címkék javítása egy sémában / a megnyitott adatbázisban ───────────────────
  // Számlálás (apply = false) vagy javítás (apply = true); a javítandó sorok: ahol a normalizált alak eltér.
  async function scanTags(schema, apply, onProg) {
    let last = -1, seen = 0, bad = 0;
    for (;;) {
      const rows = await qRows(`SELECT id, custom_tags FROM ${schema}.bookmarks WHERE id > ${Math.trunc(last)} AND custom_tags IS NOT NULL AND custom_tags <> '' ORDER BY id LIMIT ${SCAN}`);
      if (!rows.length) break;
      const ops = [];
      for (const [id, tags] of rows) {
        const v = normalizeTags(String(tags), st.cmap);
        if (v !== String(tags)) { bad++; if (apply) ops.push({ sql: 'UPDATE main.bookmarks SET custom_tags = ? WHERE id = ?', params: [v, id] }); }
      }
      if (ops.length) await batchAll(ops);
      last = rows[rows.length - 1][0]; seen += rows.length;
      if (onProg) onProg(seen);
      if (rows.length < SCAN) break;
    }
    return bad;
  }

  async function bmCtx() {
    const mi = await colInfo('main', 'bookmarks');
    const dc = await colNames(ATT, 'bookmarks');
    if (!mi.length) throw new Error('A megnyitott bookmarks.db-ben nincs „bookmarks" tábla');
    if (!dc.length) throw new Error('A másik fájlban nincs „bookmarks" tábla – ez nem a bookmarks.db?');
    if (!dc.includes('url')) throw new Error('A másik bookmarks táblában nincs url oszlop');
    const mc = mi.map(r => r[1]);
    const cmp = BM_COLS.filter(c => c !== 'id' && c !== 'url' && mc.includes(c) && dc.includes(c));     // összehasonlítható oszlopok
    const dsel = c => (dc.includes(c) ? `x.${c}` : 'NULL');
    // az új sorok beszúrásához: a megnyitott fájl oszlopai; ismeretlen, kötelező oszlop: a másik értéke vagy üres
    const tgt = [], expr = {};
    for (const [, name, type, notnull, dflt, pk] of mi) {
      if (pk || name === 'id') continue;
      if (BM_COLS.includes(name)) {
        tgt.push(name);
        expr[name] = BM_BOOL.includes(name)
          ? (dc.includes(name) ? `CASE WHEN COALESCE(x.${name}, 0) <> 0 THEN 1 ELSE 0 END` : '0')
          : (dc.includes(name) ? `COALESCE(x.${name}, '')` : "''");
      } else if (notnull && dflt == null) {
        tgt.push(name);
        expr[name] = dc.includes(name) ? `x.${name}` : (/INT|REAL|NUM|FLOA|DOUB|BOOL/i.test(type || '') ? '0' : "''");
      }
    }
    const textDiff = cmp.filter(c => !BM_BOOL.includes(c)).map(c => `COALESCE(m.${c}, '') <> COALESCE(${dsel(c)}, '')`);
    const boolDiff = cmp.filter(c => BM_BOOL.includes(c)).map(c => `(COALESCE(m.${c}, 0) <> 0) <> (COALESCE(${dsel(c)}, 0) <> 0)`);
    const differs = [...textDiff, ...boolDiff].join(' OR ') || '0';
    const conflict = ['is_read', 'pending_delete', 'protected'].filter(c => cmp.includes(c))
      .map(c => `(COALESCE(m.${c}, 0) <> 0) <> (COALESCE(${dsel(c)}, 0) <> 0)`).join(' OR ') || '0';
    const descDiff = cmp.filter(c => BM_TEXT_COLS.includes(c)).map(c => `COALESCE(m.${c}, '') <> COALESCE(${dsel(c)}, '')`).join(' OR ') || '0';
    const hasDlD = await hasTable(ATT, 'deleted_log');
    return { mc, dc, cmp, dsel, tgt, expr, differs, conflict, descDiff, hasDlD };
  }
  async function prepDups() {
    await exec('CREATE INDEX IF NOT EXISTS idx_url ON bookmarks(url)');
    await exec('CREATE TEMP TABLE IF NOT EXISTS _dups (url TEXT PRIMARY KEY)');
    await exec('DELETE FROM temp._dups');
    const rows = await qRows(`SELECT url FROM main.bookmarks WHERE COALESCE(url, '') <> '' GROUP BY url HAVING COUNT(*) > 1
      UNION SELECT url FROM ${ATT}.bookmarks WHERE COALESCE(url, '') <> '' GROUP BY url HAVING COUNT(*) > 1`);
    const urls = rows.map(r => r[0]);
    await batchAll(urls.map(u => ({ sql: 'INSERT OR IGNORE INTO temp._dups (url) VALUES (?)', params: [u] })));
    return urls;
  }
  const dropDups = async () => { try { await exec('DROP TABLE IF EXISTS temp._dups'); } catch { /* nem végzetes */ } };
  const NOT_DUP = 'NOT EXISTS (SELECT 1 FROM temp._dups dd WHERE dd.url = x.url)';
  const ONLY_B = `COALESCE(x.url, '') <> '' AND ${NOT_DUP} AND NOT EXISTS (SELECT 1 FROM main.bookmarks m WHERE m.url = x.url)`;
  const PAIR = `main.bookmarks m CROSS JOIN ${ATT}.bookmarks x ON x.url = m.url WHERE COALESCE(m.url, '') <> '' AND NOT EXISTS (SELECT 1 FROM temp._dups dd WHERE dd.url = m.url)`;

  async function preview(onProg) {
    const c = await bmCtx();
    const dups = await prepDups();
    try {
      const nA = await qVal('SELECT COUNT(*) FROM main.bookmarks');
      const nB = await qVal(`SELECT COUNT(*) FROM ${ATT}.bookmarks`);
      const onlyB = await qVal(`SELECT COUNT(*) FROM ${ATT}.bookmarks x WHERE ${ONLY_B}`);
      const coll = await qVal(`SELECT COUNT(*) FROM ${ATT}.bookmarks x WHERE ${ONLY_B} AND EXISTS (SELECT 1 FROM main.bookmarks m2 WHERE m2.id = x.id)`);
      const both = await qVal(`SELECT COUNT(*) FROM ${PAIR}`);
      const inBoth = await qVal(`SELECT COUNT(DISTINCT m.id) FROM ${ATT}.bookmarks x JOIN main.bookmarks m ON m.url = x.url WHERE COALESCE(x.url, '') <> ''`);
      const onlyA = nA - inBoth;
      const diff = await qVal(`SELECT COUNT(*) FROM ${PAIR} AND (${c.differs})`);
      const conf = await qVal(`SELECT COUNT(*) FROM ${PAIR} AND (${c.conflict})`);
      const desc = await qVal(`SELECT COUNT(*) FROM ${PAIR} AND (${c.descDiff})`);
      const noUrl = await qVal(`SELECT COUNT(*) FROM ${ATT}.bookmarks x WHERE COALESCE(x.url, '') = ''`);
      if (onProg) onProg('címkék vizsgálata…');
      const badA = await scanTags('main', false);
      const badB = await scanTags(ATT, false);
      let dl = '';
      if (c.hasDlD) {
        const dA = (await hasTable('main', 'deleted_log')) ? await qVal('SELECT COUNT(*) FROM main.deleted_log') : 0;
        const dB = await qVal(`SELECT COUNT(*) FROM ${ATT}.deleted_log`);
        const dNew = (await hasTable('main', 'deleted_log'))
          ? await qVal(`SELECT COUNT(*) FROM ${ATT}.deleted_log x WHERE NOT EXISTS (SELECT 1 FROM main.deleted_log m WHERE m.url = x.url)`) : dB;
        dl = `deleted_log: nyitott ${fmt(dA)} · másik ${fmt(dB)} → <b>+${fmt(dNew)}</b> új URL`;
      }
      return [`Megnyitott: <b>${fmt(nA)}</b> könyvjelző · másik fájl: <b>${fmt(nB)}</b>`,
        `Párosítás URL alapján. Csak a másikban: <b>${fmt(onlyB)}</b> (bekerül${coll ? `, ebből ${fmt(coll)} új azonosítót kap` : ''}) · csak a megnyitottban: <b>${fmt(onlyA)}</b> · közös: <b>${fmt(both)}</b>`,
        `Eltérő közös sor: <b>${fmt(diff)}</b> (ebből olvasott/törlésre vár/védett eltér: <b>${fmt(conf)}</b> – a szabály dönt)`,
        `Leíró mezőben (cím, kategória, tags, státusz, dátum) eltérő közös sor: <b>${fmt(desc)}</b> – ezeknél a fent választott oldal értéke marad`,
        `🏷 Javítandó címkéjű sor: megnyitott <b>${fmt(badA)}</b> · másik <b>${fmt(badB)}</b> – az eredményben mind egységes alakú lesz`,
        dups.length ? `Többször szereplő URL: <b>${fmt(dups.length)}</b> (soronként párosítva, egyik sem vész el)` : '',
        noUrl ? `⚠️ URL nélküli sor a másikban: ${fmt(noUrl)} – kimarad` : '', dl].filter(Boolean);
    } finally { await dropDups(); }
  }

  async function mergeRun(log, prim) {
    const c = await bmCtx();
    const res = { inserted: 0, updated: 0, stateChanged: 0, tagsChanged: 0, renumbered: 0, dl: 0, dupPairs: 0, tagsFixed: 0 };
    const upd = BM_COLS.filter(k => k !== 'id' && k !== 'url' && c.mc.includes(k));
    const rowOf = (arr, cols) => { const o = {}; cols.forEach((k, i) => { o[k] = arr[i]; }); return o; };
    const insCols = c.tgt, insSql = withId => `INSERT INTO main.bookmarks (${withId ? 'id, ' : ''}${insCols.join(', ')}) SELECT ${withId ? 'x.id, ' : ''}${insCols.map(k => c.expr[k]).join(', ')} FROM ${ATT}.bookmarks x`;
    const dups = await prepDups();
    try {
      return await inTx(async () => {
        const [A] = prim === 'desk' ? ['d'] : ['m'];                         // elsődleges oldal
        const resolveRows = (mRaw, dRaw, cols) => {
          const mRec = bmNorm(rowOf(mRaw, cols)), dRec = bmNorm(rowOf(dRaw, cols));
          const rec = A === 'm' ? bmResolve(mRec, dRec, st.cmap) : bmResolve(dRec, mRec, st.cmap);
          return { mRec, rec };
        };
        const diffOps = (id, mRec, rec) => {
          const sets = [], params = [];
          for (const k of upd) {
            if (rec[k] !== mRec[k]) {
              sets.push(`${k} = ?`); params.push(rec[k]);
              if (k === 'custom_tags') res.tagsChanged++;
              if (k === 'is_read' || k === 'pending_delete' || k === 'protected') res.stateChanged++;
            }
          }
          if (!sets.length) return null;
          params.push(id);
          return { sql: `UPDATE main.bookmarks SET ${sets.join(', ')} WHERE id = ?`, params };
        };

        // 1) többször szereplő URL-ek: n-edik sor az n-edikkel
        const cols = ['id', ...upd];
        for (let i = 0; i < dups.length; i += 300) {
          const part = dups.slice(i, i + 300), ph = part.map(() => '?').join(',');
          const mRows = await qRows(`SELECT m.url, m.id, ${upd.map(k => 'm.' + k).join(', ')} FROM main.bookmarks m WHERE m.url IN (${ph}) ORDER BY m.url, m.id`, part);
          const dRows = await qRows(`SELECT x.url, x.id, ${upd.map(k => c.dsel(k)).join(', ')} FROM ${ATT}.bookmarks x WHERE x.url IN (${ph}) ORDER BY x.url, x.id`, part);
          const gm = new Map(), gd = new Map();
          for (const r of mRows) { if (!gm.has(r[0])) gm.set(r[0], []); gm.get(r[0]).push(r.slice(1)); }
          for (const r of dRows) { if (!gd.has(r[0])) gd.set(r[0], []); gd.get(r[0]).push(r.slice(1)); }
          const ops = [];
          for (const [url, drs] of gd) {
            const mrs = gm.get(url) || [];
            for (let j = 0; j < drs.length; j++) {
              if (j < mrs.length) {
                const { mRec, rec } = resolveRows(mrs[j], drs[j], cols);
                res.dupPairs++;
                const op = diffOps(mrs[j][0], mRec, rec); if (op) ops.push(op);
              } else {                                                     // a másikban több példány van, mint a megnyitottban
                const free = !(await qVal('SELECT 1 FROM main.bookmarks WHERE id = ?', [drs[j][0]]));
                await run(`${insSql(free)} WHERE x.id = ${Math.trunc(Number(drs[j][0]))}`);
                res.inserted++; if (!free) res.renumbered++;
              }
            }
          }
          if (ops.length) { await batchAll(ops); res.updated += ops.length; }
        }

        // 2) a közös (egyszer szereplő) URL-ek, ahol van eltérés
        let last = -1, seen = 0;
        for (;;) {
          const rows = await qRows(`SELECT m.id, ${upd.map(k => 'm.' + k).join(', ')}, ${upd.map(k => c.dsel(k)).join(', ')}
            FROM main.bookmarks m CROSS JOIN ${ATT}.bookmarks x ON x.url = m.url
            WHERE m.id > ${Math.trunc(last)} AND COALESCE(m.url, '') <> '' AND NOT EXISTS (SELECT 1 FROM temp._dups dd WHERE dd.url = m.url) AND (${c.differs})
            ORDER BY m.id LIMIT ${CHUNK}`);
          if (!rows.length) break;
          const ops = [], n = upd.length;
          for (const r of rows) {
            const { mRec, rec } = resolveRows(r.slice(0, 1 + n), [r[0], ...r.slice(1 + n)], cols);
            const op = diffOps(r[0], mRec, rec); if (op) ops.push(op);
          }
          if (ops.length) { await batchAll(ops); res.updated += ops.length; }
          last = rows[rows.length - 1][0]; seen += rows.length;
          log(`  közös, eltérő könyvjelző átnézve: ${fmt(seen)}`, 1);
          if (rows.length < CHUNK) break;
        }
        log(`  közös sor frissítve: ${fmt(res.updated)} (állapot: ${fmt(res.stateChanged)}, címke: ${fmt(res.tagsChanged)})`, 2);

        // 3) csak a másikban lévő sorok: szabad azonosítóval, ütközésnél új azonosítót kap
        const n0 = await qVal('SELECT COUNT(*) FROM main.bookmarks');
        await run(`${insSql(true)} WHERE ${ONLY_B} AND NOT EXISTS (SELECT 1 FROM main.bookmarks m2 WHERE m2.id = x.id)`);
        const n1 = await qVal('SELECT COUNT(*) FROM main.bookmarks');
        await run(`${insSql(false)} WHERE ${ONLY_B} ORDER BY x.id`);
        const n2 = await qVal('SELECT COUNT(*) FROM main.bookmarks');
        res.inserted += n2 - n0; res.renumbered += n2 - n1;
        log(`  új könyvjelző a másik fájlból: ${fmt(res.inserted)}${res.renumbered ? ` (új azonosítót kapott: ${fmt(res.renumbered)})` : ''}`);

        // 4) deleted_log: egyesítés, a későbbi dátum marad
        if (c.hasDlD) {
          await exec('CREATE TABLE IF NOT EXISTS main.deleted_log (url TEXT PRIMARY KEY, deleted_at TEXT)');
          const d0 = await qVal('SELECT COUNT(*) FROM main.deleted_log');
          await run(`INSERT INTO main.deleted_log (url, deleted_at) SELECT x.url, x.deleted_at FROM ${ATT}.deleted_log x
            WHERE NOT EXISTS (SELECT 1 FROM main.deleted_log m WHERE m.url = x.url)`);
          const d1 = await qVal('SELECT COUNT(*) FROM main.deleted_log');
          await run(`UPDATE main.deleted_log SET deleted_at = (SELECT x.deleted_at FROM ${ATT}.deleted_log x WHERE x.url = deleted_log.url)
            WHERE EXISTS (SELECT 1 FROM ${ATT}.deleted_log x WHERE x.url = deleted_log.url AND COALESCE(x.deleted_at, '') > COALESCE(deleted_log.deleted_at, ''))`);
          res.dl = d1 - d0;
          log(`  deleted_log: +${fmt(res.dl)} URL`);
        }

        // 5) MINDEN sor címkéinek javítása (a tag_clean szabályai szerint; a javítás nem töröl, csak egységesít)
        res.tagsFixed = await scanTags('main', true, n => log(`  címkék átnézve: ${fmt(n)}`, 1));
        log(`  címkék javítva: ${fmt(res.tagsFixed)} sor`, 2);
        return res;
      });
    } finally { await dropDups(); }
  }

  // ── felület ──────────────────────────────────────────────────────────────────
  const selected = () => ($('mg-bm').checked && !$('mg-bm').disabled);
  const prim = () => ($('mg-prim-phone').checked ? 'phone' : 'desk');
  const keyNow = () => JSON.stringify([st.dir, selected(), prim()]);
  const refreshButtons = () => {
    $('merge-scan-btn').disabled = st.running;
    $('merge-preview-btn').disabled = st.running || !selected();
    $('merge-run-btn').disabled = st.running || !selected() || st.previewKey !== keyNow();
  };
  const invalidate = () => { st.previewKey = null; $('merge-preview').style.display = 'none'; refreshButtons(); };

  async function scan() {
    const dir = $('merge-dir').value.trim().replace(/\/+$/, '');
    if (!dir) { toast('⚠️ Add meg a mappát'); return; }
    if (dir !== defaultDir) lsSet('bm_path_merge', dir); else lsDel('bm_path_merge');
    st.dir = dir; invalidate();
    $('merge-result').style.display = 'none';
    const cb = $('mg-bm'), stEl = $('mgst-bm'), row = $('mgrow-bm');
    let ok = false, txt = '';
    try {
      const path = `${dir}/${FILE}`, own = env.dbPath();
      const info = await BM.checkPath({ path });
      if (!(info.exists && info.isFile)) txt = '✘ nincs ilyen fájl a mappában';
      else if (path === own) txt = '✘ ez a megnyitott adatbázis maga (válassz másik mappát)';
      else { ok = true; txt = `✔ megtalálva · ${(info.size / 1048576).toFixed(info.size > 10485760 ? 0 : 1)} MB`; }
    } catch (e) { txt = '✘ ' + errText(e); }
    cb.disabled = !ok; cb.checked = ok; row.classList.toggle('off', !ok); stEl.textContent = txt;
    refreshButtons();
  }

  async function doPreview() {
    const box = $('merge-preview');
    box.style.display = ''; box.innerHTML = 'Számolás…'; st.running = true; refreshButtons();
    try {
      const fc = await findCmap(); st.cmap = fc.cmap; st.cmapPath = fc.path;
      let out;
      try { out = await withAttached(`${st.dir}/${FILE}`, () => preview(t => { box.innerHTML = 'Számolás… ' + esc(t); })); }
      catch (e) { box.innerHTML = '❌ ' + esc(errText(e)); return; }
      box.innerHTML = out.join('<br>') + `<br><span style="color:var(--txt3)">${esc(cmapLine())}</span>`;
      st.previewKey = keyNow();
    } finally { st.running = false; refreshButtons(); }
  }

  async function backup() {
    const src = env.dbPath(), dir = `${st.dir}/mentes`, base = FILE.replace(/\.db$/, '');
    const t = new Date();
    const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
    const dst = `${dir}/${base}_elotte_${stamp}.db`;
    await BM.copyFile({ src, dst });
    try {                                                  // csak a legutóbbi 2 másolat marad
      const l = await BM.listFiles({ dir });
      const re = new RegExp(`^${base}_elotte_\\d{8}_\\d{6}\\.db$`);
      const names = (l.files || []).filter(n => re.test(n)).sort().reverse();
      for (const n of names.slice(2)) await BM.deleteFile({ path: `${dir}/${n}` });
    } catch { /* a takarítás nem kritikus */ }
    return dst;
  }

  async function runAll() {
    if (!selected() || st.previewKey !== keyNow()) { toast('Előbb nézd meg az előnézetet'); return; }
    const box = $('merge-result'), logEl = $('merge-log');
    const lines = []; let lastProg = false;
    const log = (t, mode = 0) => {                       // 0: új sor · 1: folyamatjelző (felülírja az előzőt) · 2: összegző sor (leváltja a jelzőt)
      if (mode && lastProg) lines[lines.length - 1] = t; else lines.push(t);
      lastProg = mode === 1; logEl.textContent = lines.join('\n');
    };
    box.className = 'box'; box.style.display = ''; logEl.textContent = '';
    st.running = true; refreshButtons();
    let fails = 0;
    try {
      const fc = await findCmap(); st.cmap = fc.cmap; st.cmapPath = fc.path;
      log('🔖 bookmarks.db');
      try {
        log('  biztonsági másolat készül…', 1);
        const dst = await backup();
        log(`  mentés: ${dst.replace(/^.*\//, '')}`, 2);
        await withAttached(`${st.dir}/${FILE}`, () => mergeRun(log, prim()));
        log('  ✔ kész');
      } catch (e) { fails++; log('  ❌ ' + errText(e) + ' – semmi nem változott'); }
      box.className = 'box ' + (fails ? 'no' : 'ok');
      log(fails ? '\n⚠️ Hiba történt (lásd fent).' : '\n✅ Az összevonás kész.');
      toast(fails ? '⚠️ Az összevonás hibával végzett' : '✅ Összevonás kész', 3500);
    } finally {
      st.running = false; st.previewKey = null; refreshButtons();
      try { await env.onDone(); } catch { /* nem végzetes */ }
    }
  }

  $('merge-scan-btn').onclick = scan;
  $('merge-preview-btn').onclick = () => doPreview().catch(e => { $('merge-preview').innerHTML = '❌ ' + esc(errText(e)); st.running = false; refreshButtons(); });
  $('merge-run-btn').onclick = () => runAll().catch(e => { toast('❌ ' + errText(e), 4000); st.running = false; refreshButtons(); });
  $('mg-bm').addEventListener('change', invalidate);
  $('mg-prim-desk').addEventListener('change', invalidate);
  $('mg-prim-phone').addEventListener('change', invalidate);
  $('merge-dir').addEventListener('input', invalidate);

  return {
    async open() {
      $('merge-dir').value = env.mergeDir();
      $('merge-result').style.display = 'none';
      showModal('merge-modal-overlay');
      await scan();
    },
  };
}
