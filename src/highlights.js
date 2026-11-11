// Finding the quotes an explanation rests on inside the page text, and cleaning AI output.

/** Characters that do not count when matching a quote: spaces, quotes, geresh/gershayim and punctuation. */
const SKIP = /[\s"'״׳`’‘“”,.;:!?()[\]{}<>\-–—־/\\*|]/;

/** Lowercase text without spaces and punctuation, plus a map from each kept character to its original offset. */
function normalize(text) {
  let out = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (SKIP.test(ch)) continue;
    out += ch.toLowerCase();
    map.push(i);
  }
  return { out, map };
}

/**
 * Where `quote` (as the AI wrote it, more or less verbatim) sits in `text`: flat [start, end]
 * offsets, or null. Spaces and punctuation are ignored; a quote that is not found whole is
 * matched by its longest run of consecutive words (at least 3 words, and at least 40% of the quote).
 */
export function findQuote(text, quote) {
  const page = normalize(String(text || ''));
  const hit = (q) => {
    if (q.length < 4) return null;
    const at = page.out.indexOf(q);
    if (at < 0) return null;
    return [page.map[at], page.map[at + q.length - 1] + 1];
  };
  const whole = hit(normalize(String(quote || '')).out);
  if (whole) return whole;
  const words = String(quote || '').split(/\s+/).map((w) => normalize(w).out).filter(Boolean);
  const least = Math.max(3, Math.ceil(words.length * 0.4));
  for (let len = words.length - 1; len >= least; len--) {
    for (let start = 0; start + len <= words.length; start++) {
      const r = hit(words.slice(start, start + len).join(''));
      if (r) return r;
    }
  }
  return null;
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
/**
 * Light models sometimes slip Arabic-script letters into Hebrew text (the two scripts share
 * sounds). Those characters are removed; Arabic-Indic digits become ordinary digits.
 */
export function stripForeignScript(text) {
  if (typeof text !== 'string' || !ARABIC_SCRIPT.test(text)) return text;
  return text
    .replace(ARABIC_DIGITS, (d) => String(d.codePointAt(0) >= 0x6F0 ? d.codePointAt(0) - 0x6F0 : d.codePointAt(0) - 0x660))
    .replace(ARABIC_SCRIPT, '')
    .replace(/[ \t]{2,}/g, ' ');
}

const HL = /^\d{1,12}:\d{1,6}-\d{1,6}(,\d{1,6}-\d{1,6}){0,40}(;\d{1,12}:\d{1,6}-\d{1,6}(,\d{1,6}-\d{1,6}){0,40}){0,20}$/;
/** "<letter id>:<start>-<end>,…;<letter id>:…" → [{ id, ranges: [[start, end], …] }], or null if malformed. */
export function parseHighlights(hl) {
  const str = String(hl || '');
  if (str.length > 4000 || !HL.test(str)) return null;
  return str.split(';').map((part) => {
    const [id, list] = part.split(':');
    return { id: Number(id), ranges: list.split(',').map((r) => r.split('-').map(Number)).filter(([s, e]) => e > s) };
  });
}
