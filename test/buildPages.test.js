import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHebrew, buildStream, alignPages, buildVolumeMap, headerNumbers, linesOf, pageCoverage, pageBody, placeNotes,
} from '../scripts/build-pages.mjs';

import { hebrewText, rng, syntheticVolume } from './support/synthetic-volume.js';

test('normalizeHebrew keeps Hebrew letters only and folds final forms', () => {
  const { norm, map } = normalizeHebrew('שָׁלוֹם, ךםןףץ!');
  assert.equal(norm, 'שלומכמנפצ');
  assert.equal(map.length, norm.length);
});

test('headerNumbers reads the printed number and ignores the header words', () => {
  assert.ok(headerNumbers('אדמו״י שליט״א יא').includes(11));
  assert.ok(headerNumbers('ח אדמו״ר שליט״א').includes(8));
  // OCR split the numeral into single letters
  assert.ok(headerNumbers('י ב אגרות קודש').includes(12));
  assert.deepEqual(headerNumbers('ב׳תרכט'), []);
});

test('linesOf reads each row right to left, top to bottom', () => {
  const items = [
    { str: 'א', transform: [1, 0, 0, 1, 80, 500] },
    { str: 'ב', transform: [1, 0, 0, 1, 100, 500] },
    { str: 'שלום', transform: [1, 0, 0, 1, 300, 480] },
  ];
  assert.equal(linesOf(items), 'ב א\nשלום');
});

test('buildStream maps every stream character back to its letter and offset', () => {
  const s = buildStream(['שלום', '', 'טוב']);
  assert.equal(s.norm, 'שלומטוב');
  assert.deepEqual(s.letterStart, [0, 4, 4]);
  assert.deepEqual(s.letterLen, [4, 0, 3]);
  assert.equal(s.origOf[4], 0); // 'ט' is the first character of the third letter's body
});

test('alignPages finds where each noisy page starts in the letters', () => {
  const v = syntheticVolume();
  const s = buildStream(v.bodies);
  const body = v.pdfPages.slice(1).map((t) => normalizeHebrew(t.split('\n').slice(1).join('\n')).norm);
  const starts = alignPages(s.norm, codesOf(s.norm), body).map((a) => a.start);
  starts.forEach((st, k) => {
    assert.ok(st !== null, `page ${k + 1} not matched`);
    assert.ok(Math.abs(st - 500 * k) <= 6, `page ${k + 1} starts at ${st}, expected ${500 * k}`);
  });
});

test('buildVolumeMap: front matter is unmatched, body pages split letters correctly', () => {
  const v = syntheticVolume();
  const { map, report } = buildVolumeMap({
    volume: 99, pdfName: 'synthetic.pdf', letters: v.letters, bodies: v.bodies, pdfPages: v.pdfPages,
  });

  assert.equal(map.printedOffset, 1, 'front page shifts the printed numbers by one');
  assert.equal(map.pages[0].matched, false);
  assert.ok(map.pages.slice(1).every((p) => p.matched));
  assert.ok(map.letters.every((l) => l.status === 'ok'));

  // The page that starts at stream position 1000 begins inside letter 0 (which ends at 1300).
  const page = map.pages[3]; // body page 3 (k = 2) starts at 1000
  assert.equal(page.segments[0].i, 0);
  assert.ok(Math.abs(page.segments[0].from - 1000) <= 6, `from ${page.segments[0].from}`);
  assert.equal(page.segments[1].i, 1);
  assert.ok(Math.abs(page.segments[1].from - 0) <= 6);

  // Letter 0 (0..1299) is spread over body pages 1..3 (pdf 2..4)
  assert.deepEqual(map.letters[0].pages, [2, 3, 4]);
  assert.ok(report.includes('היסט עמוד מודפס: 1'));
});

test('pageCoverage is high for matching text and low for unrelated text', () => {
  const rand = rng(3);
  const a = hebrewText(300, rand);
  const b = hebrewText(300, rand);
  assert.ok(pageCoverage(a, a, 0, a.length) > 0.95);
  assert.ok(pageCoverage(a, b, 0, b.length) < 0.2);
});

// Helper for the alignment test: the same trigram codes the module uses.
function codesOf(s) {
  const out = new Int32Array(s.length).fill(-1);
  const c = (ch) => ch.charCodeAt(0) - 0x05CF;
  for (let i = 0; i + 2 < s.length; i++) out[i] = (c(s[i]) * 28 + c(s[i + 1])) * 28 + c(s[i + 2]);
  return out;
}

test('pageBody drops the running header, the book title and a letter number, but keeps text lines', () => {
  // the first page of a volume: header row, book title lines (OCR may misread them), letter number
  const first = 'אדמו״ר שליט״א שורה עליונה\nאדמו״ר שליט״א\n— פרך שלשה עשר -\nד׳רעג\nב״ה, אדר״ח אייר\nברוקלין.';
  assert.equal(pageBody(first), 'ב״ה, אדר״ח אייר\nברוקלין.');
  // an ordinary page: a short text line (the end of the previous letter) is not a letter number
  const plain = 'header row\nברוחניות\nב׳תרכד\nב״ה, אדר״ח';
  assert.equal(pageBody(plain), 'ברוחניות\nב׳תרכד\nב״ה, אדר״ח');
});

// ---- footnotes, spaced-out headers, offset changes ----

import { dropFootnotes, pageOffsets, writtenNumeralValue } from '../scripts/build-pages.mjs';

test('headerNumbers reads a numeral inside a header that OCR spaced out letter by letter', () => {
  // 118, then the word "אגרות"
  assert.ok(headerNumbers('ק י ח א ג ר ו ת י ק ו ד ש  ע א (').includes(118));
  // 120 and then "אגרות": the א may belong to either, so both readings are offered
  const both = headerNumbers('ק כ א ג ר ו ת ־ ק ו ד ש)עב');
  assert.ok(both.includes(120) && both.includes(121));
  // the numeral at the end of a spaced-out header
  assert.ok(headerNumbers('א ד מ ו ״ ר ש ל י ט ״ א ק כ א').includes(121));
  assert.ok(!headerNumbers('א ד מ ו ״ ר ש ל י ט ״ א ק כ א').includes(122));
});

test('writtenNumeralValue accepts numerals in written order only', () => {
  assert.equal(writtenNumeralValue('קכא'), 121);
  assert.equal(writtenNumeralValue('טו'), 15);
  assert.equal(writtenNumeralValue('תתקצט'), 999);
  assert.equal(writtenNumeralValue('אק'), null);
  assert.equal(writtenNumeralValue('יי'), null);
});

test('pageOffsets follows a change of offset where the scan lacks pages', () => {
  // 60 pages; printed = pdf - 5 up to pdf 30, and pdf - 3 after it (two printed pages missing)
  const numbers = [];
  for (let pdf = 1; pdf <= 60; pdf++) numbers.push(pdf % 7 === 0 ? [] : [pdf - (pdf <= 30 ? 5 : 3)]);
  const offsets = pageOffsets(numbers, numbers.map(() => true), 5);
  assert.equal(offsets[0], 5);
  assert.equal(offsets[29], 5);
  assert.equal(offsets[30], 3);
  assert.equal(offsets[59], 3);
  // a single odd header does not change the offset
  const steady = numbers.map((_, i) => [i + 1 - 5]);
  steady[20] = [99];
  assert.ok(pageOffsets(steady, steady.map(() => true), 5).every((d) => d === 5));
});

test('dropFootnotes drops small-print lines that are not in the letters, on matched pages only', () => {
  const rand = rng(11);
  const stream = hebrewText(4000, rand);
  const note = hebrewText(120, rand);
  const page = (k) => ['כותרת', stream.slice(k, k + 60), stream.slice(k + 60, k + 120), note].join('\n');
  const pages = [page(0), page(120), page(240)];
  const sizes = pages.map(() => [12, 10, 10, 7]);
  const out = dropFootnotes(pages, sizes, stream, [true, true, false]);
  assert.equal(out[0].split('\n').length, 3, 'the footnote line is dropped');
  assert.ok(!out[0].includes(note));
  assert.equal(out[2], pages[2], 'an unmatched page is left as it is');
  // small print that is letter text stays
  const small = [['כותרת', stream.slice(0, 60), stream.slice(60, 120)].join('\n')];
  assert.equal(dropFootnotes(small.concat(pages), [[12, 10, 7]].concat(sizes), stream, [true, true, true, true])[0], small[0]);
});

test('alignPages: a page that is not found does not hide the pages after it', () => {
  const rand = rng(5);
  const stream = hebrewText(5000, rand);
  const pages = [];
  for (let k = 0; k < 10; k++) pages.push(stream.slice(k * 500, k * 500 + 500));
  pages[4] = hebrewText(500, rand); // unrelated text
  const res = alignPages(stream, codesOf(stream), pages);
  assert.equal(res[4].start, null);
  [0, 1, 2, 3, 5, 6, 7, 8, 9].forEach((k) => assert.ok(Math.abs(res[k].start - 500 * k) <= 6, `page ${k}`));
});

test('a page before pages missing from the scan keeps its own text only, also inside one long letter', () => {
  // 40 printed pages; letter 1 runs through pages 7 to 24
  const v = syntheticVolume({ lens: [3000, 9000, 6000, 2000] });
  // the scan lacks printed pages 21 and 22 (PDF pages 22 and 23)
  const pdfPages = v.pdfPages.filter((_, k) => k !== 21 && k !== 22);
  const { map } = buildVolumeMap({ volume: 99, pdfName: 'gap.pdf', letters: v.letters, bodies: v.bodies, pdfPages });
  assert.deepEqual(map.offsetChanges.map((c) => c.missingPrinted), [[21, 22]]);
  const before = map.pages.find((p) => p.printed === 20);
  const after = map.pages.find((p) => p.printed === 23);
  assert.ok(before && after, 'the pages around the gap keep their printed numbers');
  assert.equal(before.segments.at(-1).i, 1);
  assert.equal(after.segments[0].i, 1);
  // page 20 holds stream 9500-10000, which is 6500-7000 of letter 1; page 23 starts at 8000 of it
  assert.ok(Math.abs(before.segments.at(-1).to - 7000) <= 12, `page 20 ends at ${before.segments.at(-1).to}`);
  assert.ok(Math.abs(after.segments[0].from - 8000) <= 12, `page 23 starts at ${after.segments[0].from}`);
});

test('placeNotes puts each footnote on the page that prints it, in order, and keeps a lost note with the one before it', () => {
  const pageTexts = [
    'שער',
    'טקסט האגרת הראשונה בעמוד שני\nמוהר יצחק הוברמן אגרת נוספת אליו לעיל חלק ששי',
    'המשך האגרת בעמוד שלישי\nנדפסה בלקוטי שיחות חלק עשרים והוגהה על פי העתק המזכירות',
  ];
  const letterPages = [[2, 3], []];
  const notes = [[
    'מוה"ר יצחק: הוברמן, אגרת נוספת אליו - לעיל חלק ששי.',
    'הערה שאינה מופיעה באף עמוד סרוק כלל וכלל',
    'נדפסה בלקוטי שיחות חלק עשרים, והוגהה על פי העתק המזכירות.',
    'מוה"ר יצחק: הוברמן, אגרת נוספת אליו - לעיל חלק ששי.', // its text is on page 2, but it comes after a note of page 3
  ], ['הערה של אגרת שאין לה עמודים']];
  const { byPage, found, total } = placeNotes(pageTexts, letterPages, notes);
  assert.deepEqual(byPage.get(2), [[0, 0], [0, 1]]);
  assert.deepEqual(byPage.get(3), [[0, 2], [0, 3]]);
  assert.equal(total, 4);
  assert.equal(found, 2);
});

test('buildVolumeMap records the footnotes of each page and how many notes each letter has', () => {
  const v = syntheticVolume();
  const notes = v.bodies.map(() => []);
  notes[1] = ['הערה ראשונה לאגרת השניה', 'הערה שניה לאגרת השניה'];
  // letter 1 is on PDF pages 4 to 6; its second note is printed at the foot of page 5
  const pdfPages = v.pdfPages.map((t, k) => (k === 4 ? `${t}\nהערה שניה לאגרת השניה` : k === 3 ? `${t}\nהערה ראשונה לאגרת השניה` : t));
  const { map, report } = buildVolumeMap({ volume: 99, pdfName: 'n.pdf', letters: v.letters, bodies: v.bodies, notes, pdfPages });
  assert.equal(map.footnotes, true);
  assert.deepEqual(map.letters.map((l) => l.notes), [0, 2, 0, 0]);
  assert.deepEqual(map.pages[3].notes, [[1, 0]]);
  assert.deepEqual(map.pages[4].notes, [[1, 1]]);
  assert.equal(map.pages[5].notes, undefined);
  assert.match(report, /הערות שוליים של העורכים: 2\. אותרו בעמוד שלהן: 2\./);
});
