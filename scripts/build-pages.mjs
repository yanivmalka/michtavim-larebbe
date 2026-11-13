#!/usr/bin/env node
// Builds the printed-page map of one volume of Igrot Kodesh, from a scanned PDF of that volume.
//
// The scan has a text layer (OCR). The letters' text comes from chabadlibrary (src/igrot/chabadlibrary.js).
// Both are reduced to Hebrew letters only and laid out as one stream, letter after letter.
// Each printed page of the scan is then aligned to the place in the stream where its text starts.
// The result says, for every page, which letters it holds and which character range of each.
// It holds no letter text, only ids and offsets, so it can be committed.
//
// Usage (run locally, the PDFs stay on your machine):
//   node scripts/build-pages.mjs --volume 9
//   node scripts/build-pages.mjs --volume 9 --pdf data/pdfs/vol-09.pdf --out data/pages/vol-09.json
//
// Writes the map to data/pages/vol-NN.json and a Hebrew review report next to it (vol-NN.report.txt).
// Letter text is cached under .cache/letters (git-ignored) so a re-run does not fetch again.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLetter } from '../src/igrot/chabadlibrary.js';
import { bodyText, nearestWordStart } from '../src/igrot/pageMap.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HEBREW_LETTER = /[א-ת]/;
const FINAL_FORMS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const ALPHABET = 28; // Hebrew letters after the final-form mapping, plus room for one spare
const code = (ch) => ch.charCodeAt(0) - 0x05CF; // 1..27

export const ANCHOR_LEN = 60; // characters at the start of a page used to find it in the letters
export const WINDOW = 6000; // how far ahead of the previous page a page start is searched
export const MATCH_MIN = 0.45; // minimum share of anchor trigrams found at a candidate start
export const STRONG_MATCH = 0.8; // a start found this clearly is placed first; the rest go between such pages
export const PAGE_ALLOWANCE = 1500; // extra search distance for every page passed over without a clear match
export const PAGE_REVIEW_BELOW = 0.6; // page coverage below this needs a manual look
export const LETTER_OK_FROM = 0.9;
export const LETTER_PARTIAL_FROM = 0.5;
const NOTES_DIVIDER = /^\s*(-{5,}|\*{3,})\s*$/m;
const NOTE_LINE = /^[^:\n]{2,45}: \S/gm;
export const LONG_RANGE_FROM = 1.8; // a page's range this many times its own text needs a manual look

// ---------- text ----------

/** Keeps only Hebrew letters, final forms folded to base forms. `map[j]` is the offset in `text` of norm[j]. */
export function normalizeHebrew(text) {
  let norm = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!HEBREW_LETTER.test(ch)) continue;
    norm += FINAL_FORMS[ch] ?? ch;
    map.push(i);
  }
  return { norm, map };
}

/** Joins the letters' bodies (in volume order) into one normalized stream. */
export function buildStream(bodies) {
  let norm = '';
  const origOf = []; // stream index -> offset in that letter's body text
  const letterStart = []; // letter index -> stream index where it begins
  const letterLen = [];
  bodies.forEach((text) => {
    const n = normalizeHebrew(text);
    letterStart.push(norm.length);
    letterLen.push(n.norm.length);
    norm += n.norm;
    for (const off of n.map) origOf.push(off);
  });
  return { norm, origOf, letterStart, letterLen };
}

/** Code of the 3-gram starting at each index (-1 where none). */
function trigramCodes(s) {
  const out = new Int32Array(s.length).fill(-1);
  for (let i = 0; i + 2 < s.length; i++) {
    out[i] = (code(s[i]) * ALPHABET + code(s[i + 1])) * ALPHABET + code(s[i + 2]);
  }
  return out;
}

// ---------- scan text ----------

/**
 * Builds the lines of one PDF page from pdf.js text items. Items are grouped by height and read
 * right to left, since the text is Hebrew. Lines are returned top to bottom.
 */
export function linesOf(items) {
  return rowsOf(items).map((r) => r.text).join('\n');
}

/** The lines of one PDF page as `{ text, size }`, where size is the line's main font size (to 0.5 pt). */
export function rowsOf(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const size = Math.round(Math.hypot(it.transform[0], it.transform[1]) * 2) / 2;
    let row = rows.find((r) => Math.abs(r.y - y) <= 3);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, s: it.str.replace(/\n/g, ' '), size });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    const chars = new Map();
    for (const p of r.parts) chars.set(p.size, (chars.get(p.size) ?? 0) + p.s.length);
    let size = 0;
    let most = 0;
    for (const [sz, c] of chars) {
      if (c > most) {
        most = c;
        size = sz;
      }
    }
    return { text: r.parts.sort((a, b) => b.x - a.x).map((p) => p.s).join(' '), size };
  });
}

export const BODY_CLASS_FROM = 0.9; // a font size whose text is found in the letters this often is letter text
export const FOOTNOTE_LINE_BELOW = 0.8; // a line of another size found less than this is a footnote

/**
 * Drops the editors' footnotes from the pages. They are printed on the page but are not in the
 * letters' text, so they lower a page's score and blur where it ends.
 * Font size alone does not tell them apart: scans differ in scale and some letters are set in small
 * type. So the sizes that hold letter text are learned from the volume itself (on matched pages),
 * and a line is dropped only when its size is not one of those and its own text is not in the letters.
 * @param {string[]} pdfPages page texts, as lines
 * @param {number[][]} lineSizes font size of every line of every page
 * @param {string} streamNorm normalized text of all the letters
 * @param {boolean[]} matched which pages were found in the letters
 */
export function dropFootnotes(pdfPages, lineSizes, streamNorm, matched) {
  const seen = new Set();
  for (let i = 0; i + 5 <= streamNorm.length; i++) seen.add(streamNorm.slice(i, i + 5));
  const found = (line) => {
    const g = normalizeHebrew(line).norm;
    let hit = 0;
    let total = 0;
    for (let i = 0; i + 5 <= g.length; i++) {
      total += 1;
      if (seen.has(g.slice(i, i + 5))) hit += 1;
    }
    return { hit, total };
  };
  const classes = new Map();
  const lineFound = pdfPages.map((text, p) => text.split('\n').map((line, k) => {
    const f = found(line);
    if (k > 0 && matched[p]) {
      const size = lineSizes[p]?.[k];
      const c = classes.get(size) ?? { hit: 0, total: 0 };
      c.hit += f.hit;
      c.total += f.total;
      classes.set(size, c);
    }
    return f;
  }));
  const bodySizes = new Set();
  for (const [size, c] of classes) if (c.total > 0 && c.hit / c.total >= BODY_CLASS_FROM) bodySizes.add(size);
  if (bodySizes.size === 0) return pdfPages;
  // Unmatched pages (introduction, indexes) stay as they are: they quote letters, and with the rest
  // of their text dropped they would be taken for pages of the letters themselves.
  return pdfPages.map((text, p) => (!matched[p] ? text : text
    .split('\n')
    .filter((line, k) => {
      if (k === 0 || bodySizes.has(lineSizes[p]?.[k])) return true;
      const f = lineFound[p][k];
      return f.total < 4 || f.hit / f.total >= FOOTNOTE_LINE_BELOW;
    })
    .join('\n')));
}

const RUNNING_TITLE = /שליט|אגרות|כרך|פרך|שלשה|עשר|אדמו/;
const LETTER_NUMBER = /^[א-ת׳'"״ ]+$/;

/**
 * The letter text on a page: the lines after the running header, without the book's title
 * lines (at the top of the first page of a volume) and without the letter's own number heading.
 * Neither is in the letters' text, and leaving them in shifts the match of the page.
 */
export function pageBody(pageText) {
  const lines = pageText.split('\n').slice(1);
  const isTitle = (l) => l.trim().length <= 25 && RUNNING_TITLE.test(l);
  // letter numbers always carry a geresh or apostrophe (e.g. ב'תרכד); ordinary short lines do not
  const isNumber = (l) => l.trim().length <= 8 && /['׳״"]/.test(l) && LETTER_NUMBER.test(l.trim());
  let i = 0;
  while (i < 3 && i < lines.length && isTitle(lines[i])) i++;
  while (i < lines.length && isNumber(lines[i])) i++;
  return lines.slice(i).join('\n');
}

/** Text of every page of the PDF, as lines (top to bottom). */
export async function extractPages(pdfPath) {
  return (await extractPageRows(pdfPath)).pages;
}

/** Text of every page of the PDF as lines, and the font size of every line. */
export async function extractPageRows(pdfPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  const pages = [];
  const lineSizes = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const rows = rowsOf(tc.items);
    pages.push(rows.map((r) => r.text).join('\n'));
    lineSizes.push(rows.map((r) => r.size));
  }
  return { pages, lineSizes };
}

const HEBREW_NUMERALS = {
  'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6, 'ז': 7, 'ח': 8, 'ט': 9,
  'י': 10, 'כ': 20, 'ך': 20, 'ל': 30, 'מ': 40, 'ם': 40, 'נ': 50, 'ן': 50, 'ס': 60,
  'ע': 70, 'פ': 80, 'ף': 80, 'צ': 90, 'ץ': 90, 'ק': 100, 'ר': 200, 'ש': 300, 'ת': 400,
};
const HEADER_WORDS = new Set(['קודש', 'אגרות']);

/** Value of a Hebrew numeral written without geresh, such as "יא" (11). */
export function hebrewNumeralValue(token) {
  let sum = 0;
  for (const ch of token) {
    if (!(ch in HEBREW_NUMERALS)) return null;
    sum += HEBREW_NUMERALS[ch];
  }
  return sum > 0 ? sum : null;
}

/**
 * Every value a page's running header could show as its printed page number. A header reads
 * something like "אדמו״י שליט״א יא": the number is a bare Hebrew numeral, without quotes or geresh.
 * OCR often splits a numeral into single letters ("י ב" for "יב"), so runs of single letters are
 * joined. The header's other words, and letter numbers with quotes, are ignored.
 * Several values may come back (the header has more than one bare word); the caller tells them apart.
 */
export function headerNumbers(header) {
  const words = [];
  const runs = [];
  let run = '';
  const endRun = () => {
    if (!run) return;
    if (run.length > 1) runs.push(run);
    else words.push(run);
    run = '';
  };
  for (const t of header.split(/\s+/)) {
    if (/^[א-ת]$/.test(t)) {
      run += t;
      continue;
    }
    endRun();
    words.push(t);
  }
  endRun();
  const values = [];
  for (const t of words) {
    if (!/^[א-ת]{1,4}$/.test(t) || HEADER_WORDS.has(t)) continue;
    const v = hebrewNumeralValue(t);
    if (v && v <= 999) values.push(v);
  }
  // A run of single letters is a numeral that OCR spaced out ("י ב"). When OCR spaces out the whole
  // header, the numeral runs into the next word ("ק כ א ג ר ו ת" is 120 and then "אגרות") or follows
  // the previous one ("ט א ק כ א" ends with 121). The numeral is then the longest start, or the
  // longest end, of the run that is written the way a number is written.
  const offer = (v) => {
    if (v && v <= 999 && !values.includes(v)) values.push(v);
  };
  for (const r of runs) {
    for (let n = Math.min(4, r.length); n >= 1; n--) {
      const v = writtenNumeralValue(r.slice(0, n));
      if (!v) continue;
      offer(v);
      // "…א ג" may be the start of "אגרות" and not a unit of the numeral
      if (n > 1 && r[n - 1] === 'א' && r[n] === 'ג') offer(writtenNumeralValue(r.slice(0, n - 1)));
      break;
    }
    for (let n = Math.min(4, r.length); n >= 1; n--) {
      const v = writtenNumeralValue(r.slice(-n));
      if (!v) continue;
      offer(v);
      break;
    }
  }
  return values;
}

/** Value of a numeral in its written order: hundreds, then tens, then units (and טו, טז). Null otherwise. */
export function writtenNumeralValue(token) {
  if (!token || !/^(ת{0,2}[קרש]?)(טו|טז|[יכלמנסעפצ]?[א-ט]?)$/.test(token)) return null;
  return hebrewNumeralValue(token);
}

// ---------- alignment ----------

/**
 * For each page (its normalized body text), the stream index where its text starts, or null when
 * no place in the stream matches well enough (front matter, indexes, blank pages).
 * Pages are in order. First the pages whose start is found clearly are placed, each searched after
 * the one before it. Then every other page is searched only between its placed neighbours, so a
 * weak match (a page of mostly foreign text, a bad scan) cannot jump ahead and hide the pages after it.
 */
export function alignPages(streamNorm, streamCodes, pagesNorm) {
  const anchors = pagesNorm.map((pageNorm) => {
    const anchor = pageNorm.slice(0, ANCHOR_LEN);
    if (anchor.length < 12) return null;
    const codes = trigramCodes(anchor);
    const mark = new Uint8Array(ALPHABET ** 3);
    let total = 0;
    for (const c of codes) {
      if (c >= 0) {
        mark[c] = 1;
        total += 1;
      }
    }
    return { codes, mark, total, length: anchor.length };
  });
  const search = (an, lo, hi) => {
    let best = -1;
    let bestScore = 0;
    const last = Math.min(streamNorm.length - an.length, hi);
    for (let s = Math.max(0, lo); s <= last; s++) {
      let hit = 0;
      for (let i = 0; i < an.codes.length; i++) {
        const c = an.codes[i];
        if (c >= 0 && an.mark[streamCodes[s + i]]) hit += 1;
      }
      const score = hit / an.total;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return { best, bestScore };
  };

  const results = pagesNorm.map(() => ({ start: null, score: 0 }));
  // Clear matches. The window grows with every page passed over since the last one.
  let prev = -1;
  let passed = 0;
  anchors.forEach((an, i) => {
    if (!an) {
      if (prev >= 0) passed += 1;
      return;
    }
    const { best, bestScore } = search(an, prev + 1, prev + WINDOW + passed * PAGE_ALLOWANCE);
    results[i].score = bestScore;
    if (best >= 0 && bestScore >= STRONG_MATCH) {
      results[i].start = best;
      prev = best;
      passed = 0;
    } else if (prev >= 0) {
      passed += 1;
    }
  });
  // The rest, each between the placed pages around it.
  const nextPlaced = new Array(results.length).fill(null);
  let upcoming = null;
  for (let i = results.length - 1; i >= 0; i--) {
    nextPlaced[i] = upcoming;
    if (results[i].start != null) upcoming = results[i].start;
  }
  prev = -1;
  anchors.forEach((an, i) => {
    if (results[i].start != null) {
      prev = results[i].start;
      return;
    }
    if (!an) return;
    const hi = Math.min(prev + WINDOW, nextPlaced[i] != null ? nextPlaced[i] - 1 : Infinity);
    const { best, bestScore } = search(an, prev + 1, hi);
    results[i].score = bestScore;
    if (best >= 0 && bestScore >= MATCH_MIN) {
      results[i].start = best;
      prev = best;
    }
  });
  return results;
}

/**
 * Where a page's text ends in the stream: the place of its last characters, searched from the
 * page's start up to `limit`. Falls back to the page's own length when the end is not found.
 */
export function pageEnd(pageNorm, streamCodes, start, limit) {
  const byLength = Math.min(limit, start + pageNorm.length);
  const tail = pageNorm.slice(-ANCHOR_LEN);
  if (tail.length < 12) return byLength;
  const tailCodes = trigramCodes(tail);
  const mark = new Uint8Array(ALPHABET ** 3);
  let total = 0;
  for (const c of tailCodes) {
    if (c >= 0) {
      mark[c] = 1;
      total += 1;
    }
  }
  let best = -1;
  let bestScore = 0;
  const hi = Math.min(limit - tail.length, start + 2 * pageNorm.length);
  for (let s = start; s <= hi; s++) {
    let hit = 0;
    for (let i = 0; i < tailCodes.length; i++) {
      if (tailCodes[i] >= 0 && mark[streamCodes[s + i]]) hit += 1;
    }
    const score = hit / total;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best >= 0 && bestScore >= MATCH_MIN ? best + tail.length : byLength;
}

export const OFFSET_MIN_VOTES = 8; // pages that must show an offset before it is considered at all
export const OFFSET_SWITCH_COST = 4; // pages that must disagree before the offset is taken to change

/**
 * The offset (PDF page minus printed page) of every page. One offset holds for a whole volume
 * unless the scan lacks pages or has extra ones; then it changes from that place on.
 * The offsets are the cheapest path through the pages, where a page whose header does not show
 * the offset costs 1 and a change of offset costs OFFSET_SWITCH_COST.
 * @param {number[][]} numbers the numbers each page's header may show
 * @param {boolean[]} counted pages that take part (matched pages)
 * @param {number|null} main the volume's most common offset
 */
export function pageOffsets(numbers, counted, main) {
  if (main == null) return numbers.map(() => null);
  const votes = new Map();
  numbers.forEach((vals, i) => {
    if (!counted[i]) return;
    for (const d of new Set(vals.map((v) => i + 1 - v))) votes.set(d, (votes.get(d) ?? 0) + 1);
  });
  const states = [main];
  for (const [d, c] of votes) if (d !== main && c >= OFFSET_MIN_VOTES) states.push(d);
  let cost = states.map(() => 0);
  const back = [];
  numbers.forEach((vals, i) => {
    const shown = new Set(vals.map((v) => i + 1 - v));
    const next = [];
    const from = [];
    states.forEach((d, sIdx) => {
      let bestT = sIdx;
      let bestC = cost[sIdx];
      cost.forEach((c, t) => {
        if (c + OFFSET_SWITCH_COST < bestC) {
          bestC = c + OFFSET_SWITCH_COST;
          bestT = t;
        }
      });
      const miss = counted[i] && vals.length > 0 && !shown.has(d) ? 1 : 0;
      next.push(bestC + miss);
      from.push(bestT);
    });
    cost = next;
    back.push(from);
  });
  let sIdx = 0;
  cost.forEach((c, t) => {
    if (c < cost[sIdx]) sIdx = t;
  });
  const out = new Array(numbers.length);
  for (let i = numbers.length - 1; i >= 0; i--) {
    out[i] = states[sIdx];
    sIdx = back[i][sIdx];
  }
  return out;
}

/** Index of the letter that contains stream position `pos`. */
function letterAt(letterStart, pos) {
  let lo = 0;
  let hi = letterStart.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (letterStart[mid] <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Which letters a page covers, and where in each letter's body text. */
export function segmentsOf(stream, start, end) {
  const segments = [];
  for (let k = letterAt(stream.letterStart, start); k < stream.letterStart.length; k++) {
    if (stream.letterStart[k] >= end) break;
    const lStart = stream.letterStart[k];
    const lEnd = lStart + stream.letterLen[k];
    const a = Math.max(start, lStart);
    const b = Math.min(end, lEnd);
    if (b <= a) continue;
    segments.push({
      i: k,
      from: stream.origOf[a],
      to: stream.origOf[b - 1] + 1,
      n: b - a,
    });
  }
  return segments;
}

/** Share of the page's 4-grams that occur in its assigned stream range. */
export function pageCoverage(pageNorm, streamNorm, start, end) {
  const seen = new Set();
  for (let i = start; i + 4 <= end; i++) seen.add(streamNorm.slice(i, i + 4));
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 4 <= pageNorm.length; i++) {
    total += 1;
    if (seen.has(pageNorm.slice(i, i + 4))) hit += 1;
  }
  return total ? hit / total : 0;
}

const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---------- the map ----------

/**
 * Builds the page map of one volume.
 * @param {object} p
 * @param {number} p.volume
 * @param {string} p.pdfName
 * @param {[string, string][]} p.letters catalog entries [id, heading] in volume order
 * @param {string[]} p.bodies letter bodies in the same order (empty string when unavailable)
 * @param {string[]} p.pdfPages text of each PDF page, as lines
 * @param {number[][]} [p.pdfLineSizes] font size of each line of each page; with it, footnotes are dropped
 */
export function buildVolumeMap({ volume, pdfName, letters, bodies, pdfPages, pdfLineSizes }) {
  const stream = buildStream(bodies);
  const streamCodes = trigramCodes(stream.norm);

  const headers = pdfPages.map((text) => text.split('\n')[0] ?? '');
  let pagesNorm = pdfPages.map((text) => normalizeHebrew(pageBody(text)).norm);
  let aligned = alignPages(stream.norm, streamCodes, pagesNorm);
  if (pdfLineSizes) {
    const cleaned = dropFootnotes(pdfPages, pdfLineSizes, stream.norm, aligned.map((a) => a.start != null));
    pagesNorm = cleaned.map((text) => normalizeHebrew(pageBody(text)).norm);
    aligned = alignPages(stream.norm, streamCodes, pagesNorm);
  }

  // Printed page numbers: one offset (PDF page minus printed page) holds for the whole volume.
  // Each page votes once for every number its header shows; the offset with most votes wins.
  const numbers = headers.map((h) => headerNumbers(h));
  const votes = new Map();
  numbers.forEach((vals, i) => {
    for (const d of new Set(vals.map((v) => i + 1 - v))) votes.set(d, (votes.get(d) ?? 0) + 1);
  });
  let offset = null;
  let topVotes = 0;
  for (const [d, c] of votes) {
    if (c > topVotes) {
      topVotes = c;
      offset = d;
    }
  }
  if (topVotes < 10) offset = null;

  // The page's stream range runs up to the next matched page's start.
  const nextStart = new Array(aligned.length).fill(null);
  let upcoming = null;
  for (let i = aligned.length - 1; i >= 0; i--) {
    nextStart[i] = upcoming;
    if (aligned[i].start != null) upcoming = aligned[i].start;
  }

  // The offset of each page. Where it changes inside the volume, the scan lacks printed pages (the
  // offset drops) or has pages without a number (it rises).
  const isMatched = aligned.map((a) => a.start != null);
  const offsets = pageOffsets(numbers, isMatched, offset);
  const matchedIdx = aligned.map((a, i) => (a.start != null ? i : -1)).filter((i) => i >= 0);
  const confirms = (i, d) => numbers[i].includes(i + 1 - d);
  const stretch = (i) => {
    const to = nextStart[i] != null && nextStart[i] > aligned[i].start ? nextStart[i] : null;
    return to == null ? 1 : (to - aligned[i].start) / Math.max(pagesNorm[i].length, 200);
  };
  const offsetChanges = [];
  const gapAfter = new Set(); // pages whose text must not run up to the next page's start
  for (let m = 0; m + 1 < matchedIdx.length; m++) {
    const from = offsets[matchedIdx[m]];
    const to = offsets[matchedIdx[m + 1]];
    if (from === to) continue;
    // The change lies between the last page that shows the old offset and the first that shows the
    // new one. Among the pages between them, it is after the one whose text range is stretched most.
    let a = m;
    while (a > 0 && !confirms(matchedIdx[a], from)) a--;
    let b = m + 1;
    while (b + 1 < matchedIdx.length && !confirms(matchedIdx[b], to)) b++;
    let k = a;
    for (let j = a; j < b; j++) if (stretch(matchedIdx[j]) > stretch(matchedIdx[k])) k = j;
    for (let j = a; j < b; j++) offsets[matchedIdx[j]] = j <= k ? from : to;
    const at = matchedIdx[k];
    const change = { afterPdf: at + 1, afterPrinted: at + 1 - from, from, to };
    if (from > to) {
      change.missingPrinted = [at + 2 - from, at + 1 - from + (from - to)];
      gapAfter.add(at);
    }
    offsetChanges.push(change);
    m = b - 1;
  }

  const pages = aligned.map((a, i) => {
    const rec = {
      pdf: i + 1,
      printed: offsets[i] != null && a.start != null ? i + 1 - offsets[i] : null,
      headerNumbers: numbers[i],
      matched: a.start != null,
      anchorScore: round(a.score),
      pageScore: null,
      segments: [],
    };
    if (a.start != null) {
      const upTo = nextStart[i] != null && nextStart[i] > a.start ? nextStart[i] : null;
      let end;
      if (upTo != null && gapAfter.has(i)) end = pageEnd(pagesNorm[i], streamCodes, a.start, upTo);
      else end = upTo ?? Math.min(stream.norm.length, a.start + pagesNorm[i].length);
      if (!gapAfter.has(i) && pagesNorm[i].length >= 200 && stretch(i) >= LONG_RANGE_FROM) {
        // Some letters end with the author's notes: after a line of dashes or stars, or as lines
        // that open with the words they refer to and a colon. In print the notes are footnotes
        // spread over the letter's pages, so the letter's last page gets a long range.
        const hasNotes = segmentsOf(stream, a.start, end).some((seg) => {
          const part = bodies[seg.i].slice(seg.from, seg.to);
          return NOTES_DIVIDER.test(part) || (part.match(NOTE_LINE) ?? []).length >= 2;
        });
        rec._long = hasNotes ? 'notes' : 'unknown';
      }
      rec.segments = segmentsOf(stream, a.start, end).map(({ i: k, from, to }) => ({ i: k, from, to }));
      rec.pageScore = round(pageCoverage(pagesNorm[i], stream.norm, a.start, end));
      rec._segFull = segmentsOf(stream, a.start, end);
    }
    return rec;
  });

  // A page break inside a letter falls between two words, not in the middle of one.
  const textPagesList = pages.filter((p) => p.matched && p.segments.length);
  for (let j = 0; j + 1 < textPagesList.length; j++) {
    const last = textPagesList[j].segments.at(-1);
    const first = textPagesList[j + 1].segments[0];
    if (gapAfter.has(textPagesList[j].pdf - 1)) {
      // The scan lacks the pages after this one: its text ends where the page ends, not where the
      // next scanned page starts, even when the same letter carries on there.
      const end = nearestWordStart(bodies[last.i], last.to);
      if (end > last.from) last.to = end;
      continue;
    }
    if (last.i !== first.i) continue;
    const at = nearestWordStart(bodies[last.i], first.from);
    if (at <= last.from) continue;
    last.to = at;
    first.from = at;
  }

  const letterRecs = letters.map(([id, heading], k) => {
    let covered = 0;
    const pdfPagesOf = [];
    for (const rec of pages) {
      for (const seg of rec._segFull ?? []) {
        if (seg.i !== k) continue;
        covered += seg.n;
        pdfPagesOf.push(rec.pdf);
      }
    }
    const len = stream.letterLen[k];
    const cov = len ? covered / len : 0;
    const status = len === 0 ? 'empty' : cov >= LETTER_OK_FROM ? 'ok' : cov >= LETTER_PARTIAL_FROM ? 'partial' : 'missing';
    return { i: k, id, heading, bodyLength: bodies[k].length, pages: [...new Set(pdfPagesOf)], coverage: round(cov), status };
  });
  const longRange = pages.filter((p) => p._long === 'unknown').map((p) => p.pdf);
  const longNotes = pages.filter((p) => p._long === 'notes').map((p) => p.pdf);
  for (const rec of pages) {
    delete rec._segFull;
    delete rec._long;
  }

  const unconfirmed = pages.filter(
    (p) => p.matched && !(p.printed != null && p.headerNumbers.includes(p.printed)),
  ).length;
  const report = makeReport({ volume, pdfName, pages, letterRecs, offset, unconfirmed, offsetChanges, longRange, longNotes });
  const map = {
    volume,
    pdf: pdfName,
    pdfPages: pdfPages.length,
    printedOffset: offset,
    offsetChanges,
    letters: letterRecs,
    pages,
  };
  return { map, report };
}

function ranges(nums) {
  const out = [];
  for (const n of nums) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ') || '—';
}

function makeReport({ volume, pdfName, pages, letterRecs, offset, unconfirmed, offsetChanges = [], longRange = [], longNotes = [] }) {
  const withNumber = pages.filter((p) => p.matched && p.headerNumbers.length > 0).length;
  const agree = withNumber - unconfirmed;
  const matched = pages.filter((p) => p.matched);
  const unmatched = pages.filter((p) => !p.matched).map((p) => p.pdf);
  const pageReview = matched.filter((p) => p.pageScore < PAGE_REVIEW_BELOW).map((p) => p.pdf);
  const count = (s) => letterRecs.filter((l) => l.status === s).length;
  const partial = letterRecs.filter((l) => l.status === 'partial');
  const missing = letterRecs.filter((l) => l.status === 'missing');
  const split = letterRecs.filter((l) => l.pages.length > 1).length;
  const lines = [
    `כרך ${volume}: ${pdfName}`,
    `עמודי PDF: ${pages.length}. עמודי גוף שנמצאו באגרות: ${matched.length}. ללא התאמה: ${unmatched.length} (${ranges(unmatched)}).`,
    offset == null
      ? 'היסט עמוד מודפס: לא נקבע (לא נמצאו כותרות עם מספר).'
      : `היסט עמוד מודפס: ${offset}. נקבע לפי הכותרות, ותואם בכותרת של ${agree} מתוך ${withNumber} עמודי גוף עם מספר.`,
    '',
    `אגרות בכרך: ${letterRecs.length}`,
    `  תקינות (כיסוי מעל 90%): ${count('ok')}`,
    `  חלקיות (כיסוי 50%-90%), לבדיקה: ${partial.length}`,
    `  חסרות (כיסוי מתחת ל-50%), לבדיקה: ${missing.length}`,
    `  ריקות בקטלוג: ${count('empty')}`,
    `  מפוצלות בין שני עמודים או יותר: ${split}`,
    '',
    `עמודים בציון נמוך (מתחת ל-60%), לבדיקה: ${pageReview.length} (${ranges(pageReview)})`,
    `עמודי גוף שכותרתם לא אישרה את המספר המודפס: ${unconfirmed} (בדרך כלל שגיאות OCR בכותרת)`,
    `שינויי היסט בתוך הכרך, לבדיקה: ${offsetChanges.length}`,
    ...offsetChanges.map((c) => (c.missingPrinted
      ? `  אחרי עמוד PDF ${c.afterPdf} (מודפס ${c.afterPrinted}) ההיסט יורד מ-${c.from} ל-${c.to}: בסריקה חסרים העמודים המודפסים ${c.missingPrinted[0]}–${c.missingPrinted[1]}. הטקסט שלהם לא משויך לאף עמוד.`
      : `  אחרי עמוד PDF ${c.afterPdf} (מודפס ${c.afterPrinted}) ההיסט עולה מ-${c.from} ל-${c.to}: בסריקה יש עמודים בלי מספר, או דילוג במספור.`)),
    `עמודים שהטווח שלהם ארוך בהרבה מהטקסט שבעמוד (ייתכן שחסר עמוד אחריהם), לבדיקה: ${longRange.length} (${ranges(longRange)})`,
    `עמודים שהטווח שלהם ארוך, כנראה כי האגרת מסתיימת בהערות (בדפוס הן הערות שוליים בעמודי האגרת): ${longNotes.length} (${ranges(longNotes)})`,
    '',
  ];
  if (partial.length || missing.length) {
    lines.push('אגרות לבדיקה:');
    for (const l of [...missing, ...partial]) {
      lines.push(`  ${l.heading} (${l.id}): כיסוי ${Math.round(l.coverage * 100)}%, עמודי PDF ${ranges(l.pages)}`);
    }
  }
  return lines.join('\n');
}

// ---------- CLI ----------

async function loadBodies(letters, { fetchFn = fetch, cacheDir = join(ROOT, '.cache', 'letters') } = {}) {
  await mkdir(cacheDir, { recursive: true });
  const bodies = [];
  for (const [id] of letters) {
    const file = join(cacheDir, `${id}.json`);
    let body;
    if (existsSync(file)) {
      body = JSON.parse(await readFile(file, 'utf8'));
    } else {
      try {
        const letter = await fetchLetter(id, fetchFn);
        body = bodyText(letter.blocks);
      } catch (err) {
        console.warn(`אגרת ${id}: לא נטענה (${err.message}), תיחשב כריקה.`);
        body = '';
      }
      await writeFile(file, JSON.stringify(body));
    }
    bodies.push(body);
  }
  return bodies;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const volume = Number(args.volume);
  if (!volume) {
    console.error('שימוש: node scripts/build-pages.mjs --volume <מספר כרך> [--pdf <קובץ>] [--out <קובץ>]');
    process.exit(1);
  }
  const pad = String(volume).padStart(2, '0');
  const pdfPath = args.pdf ?? join(ROOT, 'data', 'pdfs', `vol-${pad}.pdf`);
  const outPath = args.out ?? join(ROOT, 'data', 'pages', `vol-${pad}.json`);

  const catalog = JSON.parse(await readFile(join(ROOT, 'data', 'catalog.json'), 'utf8'));
  const vol = catalog.volumes.find((v) => v.volume === volume);
  if (!vol) throw new Error(`כרך ${volume} לא נמצא בקטלוג`);

  console.log(`טוען ${vol.letters.length} אגרות מהקטלוג...`);
  const bodies = await loadBodies(vol.letters);
  console.log(`קורא את ${basename(pdfPath)}...`);
  const { pages: pdfPages, lineSizes: pdfLineSizes } = await extractPageRows(pdfPath);

  const { map, report } = buildVolumeMap({
    volume,
    pdfName: basename(pdfPath),
    letters: vol.letters,
    bodies,
    pdfPages,
    pdfLineSizes,
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(map, null, 1) + '\n');
  const reportPath = outPath.replace(/\.json$/, '.report.txt');
  await writeFile(reportPath, report + '\n');
  console.log(report);
  console.log(`\nנכתב: ${outPath}\nדוח: ${reportPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
