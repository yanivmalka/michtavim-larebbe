// Aramaic words explained from dictionaries, not by the AI: the built-in Aramaic–Hebrew dictionary
// (public/aramaic.js) first, and for the words it does not have, Jastrow's dictionary of the Targumim, the Talmud
// and the Midrash, through Sefaria's open lexicon API (definitions in English).
import { aramaicPhrase, bareWord, glossOf, stemsOf } from '../public/aramaic.js';

const SEFARIA = 'https://www.sefaria.org/api/words/';
const cache = new Map(); // word → { headword, meaning } | null
const remember = (k, v) => { cache.set(k, v); if (cache.size > 3000) cache.delete(cache.keys().next().value); return v; };

const unHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** Every `definition` in a Sefaria lexicon entry, in order (senses can nest). */
function definitions(node, out = []) {
  if (!node || typeof node !== 'object' || out.length >= 6) return out;
  if (Array.isArray(node)) { for (const n of node) definitions(n, out); return out; }
  if (typeof node.definition === 'string' && unHtml(node.definition)) out.push(unHtml(node.definition));
  if (node.senses) definitions(node.senses, out);
  return out;
}

/** Jastrow's entry for `word` (Sefaria), as { headword, meaning }, or null. */
export async function lookupJastrow(word, fetchImpl = globalThis.fetch) {
  const w = bareWord(word);
  if (!w) return null;
  if (cache.has(w)) return cache.get(w);
  const res = await fetchImpl(`${SEFARIA}${encodeURIComponent(w)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`lexicon ${res.status}`);
  const list = await res.json();
  const entries = (Array.isArray(list) ? list : []).filter((e) => /jastrow/i.test(String(e?.parent_lexicon || '')));
  for (const e of entries) {
    const defs = definitions(e.content);
    if (defs.length) {
      const meaning = defs.slice(0, 2).join('; ');
      return remember(w, { headword: bareWord(e.headword) || w, meaning: meaning.length > 220 ? `${meaning.slice(0, 219)}…` : meaning });
    }
  }
  return remember(w, null);
}

/**
 * The Aramaic phrase around `word` in `sentence`, explained word by word: the built-in dictionary (Hebrew), then
 * Jastrow (English). When every word is in the built-in dictionary, a literal word-by-word rendering is given too.
 */
export async function explainAramaic({ sentence, word, language = 'he' }, deps = {}) {
  const words = aramaicPhrase(sentence, word);
  const lookup = deps.lookup || ((w) => lookupJastrow(w, deps.fetch));
  let online = 0, offline = false;
  const out = [];
  for (const w of words.slice(0, 16)) {
    const bare = bareWord(w);
    const local = glossOf(bare);
    if (local && language === 'he') { out.push({ word: bare, meaning: local.meaning, source: 'dict' }); continue; }
    let hit = null;
    if (!offline) {
      for (const form of stemsOf(bare)) {
        try { hit = await lookup(form); } catch { offline = true; break; } // the online dictionary is not answering: the rest from ours
        if (hit) break;
      }
    }
    if (hit) { online += 1; out.push({ word: bare, meaning: hit.meaning, source: 'jastrow', headword: hit.headword }); }
    else if (local) out.push({ word: bare, meaning: local.meaning, source: 'dict' });
    else out.push({ word: bare, meaning: '', source: '' });
  }
  const known = out.filter((x) => x.meaning);
  const literal = known.length === out.length && out.every((x) => x.source === 'dict')
    ? out.map((x) => x.meaning.split(' / ')[0].replace(/\s*\(.*?\)\s*/g, ' ').trim()).join(' ')
    : '';
  return {
    isAramaic: known.length > 0,
    phrase: words.join(' '),
    translation: literal,
    words: out,
    sources: [...new Set(out.map((x) => x.source).filter(Boolean))],
    offline: offline && !online,
  };
}
