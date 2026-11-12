// URL-normalizálás (az asztali Hír-Radar normalize_url_fetch átirata) és az MHTML-fájlok azonosítója.
// Ugyanaz, mint a Hír-Radar Mobilban: így a Hír-Radarból exportált cikkek MHTML fájlját a BM az URL-ből megtalálja.
// ── URL-normalizálás ───────────────────────────────────────────────────────────
const FETCH_TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_reader',
  'fbclid', 'gclid', 'partner', 'ref', 'source', 'mc_cid', 'mc_eid', 'trk', 'wt.mc_id', 'rss_feed']);
function splitUrl(u) {
  u = String(u || '').trim().toLowerCase();
  let frag = '';
  const hi = u.indexOf('#');
  if (hi >= 0) { frag = u.slice(hi); u = u.slice(0, hi); if (frag === '#') frag = ''; }
  let qs = '';
  const qi = u.indexOf('?');
  if (qi >= 0) { qs = u.slice(qi + 1); u = u.slice(0, qi); }
  return { base: u, qs, frag };
}
export function normalizeUrlFetch(url) {
  const { base, qs, frag } = splitUrl(url);
  const kept = qs.split('&').filter(p => {
    if (!p) return false;
    let k = p.split('=')[0];
    try { k = decodeURIComponent(k.replace(/\+/g, ' ')); } catch { /* marad */ }
    return !FETCH_TRACKING_PARAMS.has(k.toLowerCase());
  });
  let r = base + (kept.length ? '?' + kept.join('&') : '') + frag;
  if (!r.includes('#')) r = r.replace(/\/+$/, '');
  return r;
}

// ── MHTML azonosító: HR + az URL-ből számolt 14 hexa jegy (…_idHR<14 hexa>_domain.mhtml) ──
function cyrb53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export const mhtmlHashId = url => 'HR' + cyrb53(normalizeUrlFetch(url)).toString(16).padStart(14, '0');
