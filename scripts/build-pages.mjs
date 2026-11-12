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
export const PAGE_REVIEW_BELOW = 0.6; // page coverage below this needs a manual look
export const LETTER_OK_FROM = 0.9;
export const LETTER_PARTIAL_FROM = 0.5;

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
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= 3);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((r) => r.parts.sort((a, b) => b.x - a.x).map((p) => p.s).join(' '))
    .join('\n');
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
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    pages.push(linesOf(tc.items));
  }
  return pages;
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
  let run = '';
  for (const t of header.split(/\s+/)) {
    if (/^[א-ת]$/.test(t)) {
      run += t;
      continue;
    }
    if (run) words.push(run);
    run = '';
    words.push(t);
  }
  if (run) words.push(run);
  const values = [];
  for (const t of words) {
    if (!/^[א-ת]{1,4}$/.test(t) || HEADER_WORDS.has(t)) continue;
    const v = hebrewNumeralValue(t);
    if (v && v <= 999) values.push(v);
  }
  return values;
}

// ---------- alignment ----------

/**
 * For each page (its normalized body text), the stream index where its text starts, or null when
 * no place in the stream matches well enough (front matter, indexes, blank pages).
 * Pages are in order, so each search starts after the previous page's start.
 */
export function alignPages(streamNorm, streamCodes, pagesNorm) {
  const results = [];
  let prev = -1;
  for (const pageNorm of pagesNorm) {
    const anchor = pageNorm.slice(0, ANCHOR_LEN);
    if (anchor.length < 12) {
      results.push({ start: null, score: 0 });
      continue;
    }
    const anchorCodes = trigramCodes(anchor);
    const mark = new Uint8Array(ALPHABET ** 3);
    let total = 0;
    for (const c of anchorCodes) {
      if (c >= 0) {
        mark[c] = 1;
        total += 1;
      }
    }
    let best = -1;
    let bestScore = 0;
    const lo = Math.max(0, prev + 1);
    const hi = Math.min(streamNorm.length - anchor.length, prev + WINDOW);
    for (let s = lo; s <= hi; s++) {
      let hit = 0;
      for (let i = 0; i < anchorCodes.length; i++) {
        const c = anchorCodes[i];
        if (c >= 0 && mark[streamCodes[s + i]]) hit += 1;
      }
      const score = hit / total;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best >= 0 && bestScore >= MATCH_MIN) {
      results.push({ start: best, score: bestScore });
      prev = best;
    } else {
      results.push({ start: null, score: bestScore });
    }
  }
  return results;
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
 */
export function buildVolumeMap({ volume, pdfName, letters, bodies, pdfPages }) {
  const stream = buildStream(bodies);
  const streamCodes = trigramCodes(stream.norm);

  const headers = pdfPages.map((text) => text.split('\n')[0] ?? '');
  const pagesNorm = pdfPages.map((text) => normalizeHebrew(pageBody(text)).norm);
  const aligned = alignPages(stream.norm, streamCodes, pagesNorm);

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

  const pages = aligned.map((a, i) => {
    const rec = {
      pdf: i + 1,
      printed: offset != null && a.start != null ? i + 1 - offset : null,
      headerNumbers: numbers[i],
      matched: a.start != null,
      anchorScore: round(a.score),
      pageScore: null,
      segments: [],
    };
    if (a.start != null) {
      const end = nextStart[i] != null && nextStart[i] > a.start
        ? nextStart[i]
        : Math.min(stream.norm.length, a.start + pagesNorm[i].length);
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
  for (const rec of pages) delete rec._segFull;

  const unconfirmed = pages.filter(
    (p) => p.matched && !(offset != null && p.headerNumbers.includes(p.pdf - offset)),
  ).length;
  const report = makeReport({ volume, pdfName, pages, letterRecs, offset, unconfirmed });
  const map = {
    volume,
    pdf: pdfName,
    pdfPages: pdfPages.length,
    printedOffset: offset,
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

function makeReport({ volume, pdfName, pages, letterRecs, offset, unconfirmed }) {
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
  const pdfPages = await extractPages(pdfPath);

  const { map, report } = buildVolumeMap({
    volume,
    pdfName: basename(pdfPath),
    letters: vol.letters,
    bodies,
    pdfPages,
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
