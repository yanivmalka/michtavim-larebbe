import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHebrew, buildStream, alignPages, buildVolumeMap, headerNumbers, linesOf, pageCoverage,
} from '../scripts/build-pages.mjs';

// Synthetic volume: letters made of Hebrew letters only, scanned pages cut from them with OCR noise.
const LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת';
function rng(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}
function hebrewText(n, rand) {
  let s = '';
  for (let i = 0; i < n; i++) s += LETTERS[Math.floor(rand() * LETTERS.length)];
  return s;
}
const noisy = (s) => [...s].map((ch, i) => (i % 17 === 16 ? (ch === 'ו' ? 'י' : 'ו') : ch)).join('');
const wrap = (s) => s.match(/.{1,60}/g).join('\n');
const NUMERALS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י', 'יא', 'יב'];

function syntheticVolume() {
  const rand = rng(7);
  const lens = [1300, 1100, 2000, 1600];
  const bodies = lens.map((n) => hebrewText(n, rand));
  const stream = bodies.join('');
  const front = 'שער הכרך\n' + wrap(hebrewText(400, rand));
  const pages = [front];
  for (let k = 0; k < 12; k++) {
    const chunk = stream.slice(500 * k, 500 * k + 500);
    pages.push(`${NUMERALS[k]} אגרות קודש\n` + wrap(noisy(chunk)));
  }
  const letters = bodies.map((_, k) => [`id${k}`, `h${k}`]);
  return { bodies, letters, pdfPages: pages, lens };
}

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
