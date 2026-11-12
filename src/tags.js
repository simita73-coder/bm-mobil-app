// Címke-segédek (a tag_clean.py JS-átirata + az asztali DB Kezelő címke-egyesítése)
// ── címke-normalizálás (a tag_clean.py JS-átirata) ─────────────────────────────
export const WRAP_CHARS = '[]"“”„‟«»';
export function trimChars(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
export function stripWrappers(t) {
  t = t.trim();
  for (;;) {
    let n = trimChars(t.trim(), WRAP_CHARS).trim();
    if (n.length > 2 && n[0] === "'" && n[n.length - 1] === "'" && n.split("'").length - 1 === 2) n = n.slice(1, -1).trim();
    if (n === t) return n;
    t = n;
  }
}
export function isAcronymShape(tok) {
  if (!(tok.toUpperCase() === tok && tok.toLowerCase() !== tok)) return false;     // csupa nagybetű
  const letters = (tok.match(/\p{L}/gu) || []).length;
  return letters >= 2 || (letters >= 1 && /\d/.test(tok));
}
export function canonToken(tok, cmap) {
  const low = tok.toLowerCase();
  if (cmap && Object.prototype.hasOwnProperty.call(cmap, low)) return cmap[low];
  return isAcronymShape(tok) ? tok : low;
}
export function splitTags(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter(x => x != null).map(x => String(x).replace(/,/g, ' '));
  const s = String(value).trim();
  let items = null;
  if (s.startsWith('[')) {
    try { const v = JSON.parse(s); if (Array.isArray(v)) items = v.filter(x => x != null).map(String); } catch {
      // Python-lista alak: ['a', 'b'] (csak ha az egész szöveg ilyen; különben sima vesszős lista)
      if (/^\[\s*((?:'[^']*'|"[^"]*")\s*(?:,\s*(?:'[^']*'|"[^"]*")\s*)*,?\s*)?\]$/.test(s)) {
        items = [...s.matchAll(/'([^']*)'|"([^"]*)"/g)].map(x => x[1] != null ? x[1] : x[2]);
      }
    }
  }
  if (items == null) return s.split(',');
  return items.map(x => x.replace(/,/g, ' '));
}
export function normalizeTags(value, cmap) {
  const seen = new Set(), out = [];
  for (const raw of splitTags(value)) {
    let t = stripWrappers(raw.replace(/\s+/g, ' '));
    if (!t) continue;
    t = t.split(' ').map(tok => canonToken(tok, cmap)).join(' ');
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(t);
  }
  return out.join(', ');
}
// meglévő BM-címkékhez hozzáadja az újakat (a meglévőket nem írja át)
export function unionTags(existing, added) {
  const base = String(existing || '').split(',').map(t => t.trim()).filter(Boolean);
  const have = new Set(base.map(t => t.toLowerCase()));
  for (const t of String(added || '').split(',').map(x => x.trim()).filter(Boolean)) {
    if (!have.has(t.toLowerCase())) { have.add(t.toLowerCase()); base.push(t); }
  }
  return base.join(', ');
}

// Két címkelista egyesítése az asztali DB Kezelő (union_tags) szabályai szerint:
//  • ha van címke-szótár (cmap): a teljes eredmény a tag_clean szabályai szerint normalizált;
//  • ha nincs: a meglévő (a) címkékhez nem nyúl, csak a b-ből hiányzókat fűzi hozzá.
// A kis/nagybetű nélküli duplikátumokat kiszűri; az a == b vagy üres b esetén a-t adja vissza.
export function unionTagsMerge(a, b, cmap) {
  a = a || ''; b = b || '';
  if (!b.trim() || a === b) return a;
  if (!a.trim()) return b;
  const useMap = !!cmap && Object.keys(cmap).length > 0;
  const seen = new Set(), out = [];
  for (const raw of [...splitTags(a), ...splitTags(b)]) {
    let t = stripWrappers(raw.replace(/\s+/g, ' '));
    if (!t) continue;
    if (useMap) t = t.split(' ').map(tok => canonToken(tok, cmap)).join(' ');
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(t);
  }
  return out.join(', ');
}
