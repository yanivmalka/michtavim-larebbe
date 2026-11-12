// Letter numbers of Igrot Kodesh, as printed ("א'תתקסו", "קמא*"), and where each letter is in the catalog.
// The numbering runs on through all the volumes, so a number alone identifies the letter.
// Letters added later carry an asterisk (קמא* comes after קמא); "**" is a second such letter.

const VALUES = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50, ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100, ר: 200, ש: 300, ת: 400 };

const sumOf = (letters) => {
  let total = 0;
  for (const ch of letters) {
    if (!VALUES[ch]) return null;
    total += VALUES[ch];
  }
  return total;
};

/**
 * "א'תתקסו" → { n: 1966, stars: 0 }, "קמא*" → { n: 141, stars: 1 }, "1966" → { n: 1966, stars: 0 }.
 * Thousands are written as one letter with a geresh before the rest. null if it is not a number.
 */
export function parseLetterNumber(raw) {
  let s = String(raw ?? '').normalize('NFC')
    .replace(/[֑-ׇ]/g, '') // niqqud / cantillation
    .replace(/[׳’‘`´]/g, "'").replace(/[״“”]/g, '"')
    .replace(/^\s*(אגרת|מכתב|letter)\s*/i, '').replace(/\s+/g, '');
  const stars = (s.match(/\*/g) || []).length;
  s = s.replace(/\*/g, '');
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 0 ? { n, stars } : null; }
  let thousands = 0;
  const m = /^([א-י])'(.+)$/.exec(s); // א' = 1,000 … י' = 10,000
  if (m) { thousands = VALUES[m[1]] * 1000; s = m[2]; }
  s = s.replace(/["']/g, '');
  if (!s && thousands) return { n: thousands, stars };
  if (!/^[א-ת]+$/.test(s)) return null;
  const rest = sumOf(s);
  return rest ? { n: thousands + rest, stars } : null;
}

const keyOf = (p) => `${p.n}${'*'.repeat(p.stars)}`;

const indexes = new WeakMap();
/** number key ("1966", "141*") → { v, i } for every letter in the catalog. */
export function letterIndex(volumes) {
  let idx = indexes.get(volumes);
  if (idx) return idx;
  idx = new Map();
  volumes.forEach((vol, v) => vol.letters.forEach(([, heading], i) => {
    const p = parseLetterNumber(heading);
    if (p && !idx.has(keyOf(p))) idx.set(keyOf(p), { v, i });
  }));
  indexes.set(volumes, idx);
  return idx;
}

/** Where the letter numbered `raw` is: { v, i } or null. Falls back to the number without its asterisk. */
export function findLetter(volumes, raw) {
  const p = parseLetterNumber(raw);
  if (!p) return null;
  const idx = letterIndex(volumes);
  return idx.get(keyOf(p)) || idx.get(String(p.n)) || null;
}

/** "כרך יג", "חלק יג", "13" → index of that volume in the catalog, or -1. */
export function findVolume(volumes, raw) {
  const s = String(raw ?? '').replace(/^\s*(כרך|חלק|volume|vol\.?)\s*/i, '').replace(/["'\s]/g, '');
  if (!s) return -1;
  const n = /^\d+$/.test(s) ? Number(s) : sumOf(s);
  return n ? volumes.findIndex((vol) => vol.volume === n) : -1;
}
