import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findQuote, stripForeignScript, parseHighlights } from '../src/highlights.js';
import { layout, mergeBoxes, PAGE } from '../src/render/bookPage.js';
import { renderSpec, encodeSpec } from '../src/igrot/openBook.js';
import { getPageImage, highlightsFor, acronyms, analyze } from '../src/letters.js';

test('findQuote ignores spaces, quotes and punctuation, and falls back to the longest run of words', () => {
  const text = 'שלום וברכה! במענה על מכתבו מיום כ"ד ניסן, בו כותב אודות הבריאות. ובטח ימשיך בלימוד התורה.';
  assert.equal(text.slice(...findQuote(text, 'במענה על מכתבו מיום כ״ד ניסן')), 'במענה על מכתבו מיום כ"ד ניסן');
  assert.equal(text.slice(...findQuote(text, 'ובטח  ימשיך בלימוד התורה')), 'ובטח ימשיך בלימוד התורה');
  // the model changed a word in the middle: the longest matching run is taken
  const partial = findQuote(text, 'במענה על מכתבו מאתמול בו כותב אודות הבריאות');
  assert.equal(text.slice(...partial), 'בו כותב אודות הבריאות');
  assert.equal(findQuote(text, 'מילים שאינן בעמוד כלל'), null);
  assert.equal(findQuote(text, 'כ"ד'), null, 'too short to be a source');
});

test('stripForeignScript removes Arabic letters and keeps Hebrew, Latin and digits', () => {
  assert.equal(stripForeignScript('ברכה והצלחה'), 'ברכה והצלחה');
  assert.equal(stripForeignScript('ברכה וهצלחה בשנת ٥٧٨٦'), 'ברכה וצלחה בשנת 5786');
  assert.equal(stripForeignScript('Hello, שלום'), 'Hello, שלום');
  assert.equal(stripForeignScript(undefined), undefined);
});

test('parseHighlights accepts only the compact form', () => {
  assert.deepEqual(parseHighlights('11:3-9,20-25;12:0-4'), [{ id: 11, ranges: [[3, 9], [20, 25]] }, { id: 12, ranges: [[0, 4]] }]);
  assert.deepEqual(parseHighlights('11:9-3'), [{ id: 11, ranges: [] }]);
  assert.equal(parseHighlights('x:1-2'), null);
  assert.equal(parseHighlights('11:1-2;'), null);
});

const para = (n) => Array.from({ length: n }, (_, i) => `מילה${i}`).join(' ');
const letters = {
  11: { letterHeading: 'א', blocks: [{ kind: 'date', text: 'ב"ה, כ"ד ניסן' }, { kind: 'text', text: `שלום וברכה! ${para(60)}` }, { kind: 'text', text: 'ובטח ימשיך בלימוד התורה בהתמדה ושקידה.' }], viewerUrl: 'u11' },
  12: { letterHeading: 'ב', blocks: [{ kind: 'text', text: para(400) }], viewerUrl: 'u12' },
};
const volumes = [{ volume: 1, heading: 'כרך א', letters: [[11, 'א'], [12, 'ב']] }];
const fetchLetter = async (id) => ({ id, text: 'x', ...letters[id] });

test('layout places every word on the page, with its offsets in the shown text', () => {
  const flow = [{ kind: 'number', text: 'א', letter: 0 }, { kind: 'text', text: 'שלום וברכה', letter: 0 }, { kind: 'text', text: para(5), letter: 0 }];
  const { shown, boxes } = layout(flow, { header: { right: 'r', left: 'l' } });
  const text = shown.get(0).text;
  assert.equal(text, `א\nשלום וברכה\n${para(5)}`);
  for (const b of boxes) {
    assert.equal(b.page, 0);
    assert.ok(b.x >= PAGE.side - 1 && b.x + b.w <= PAGE.width - PAGE.side + 1, 'inside the margins');
    assert.ok(b.w > 0 && b.h > 0);
    assert.match(text.slice(b.s, b.e), /^\S+$/, 'each box is exactly one word');
  }
  assert.deepEqual(boxes.map((b) => text.slice(b.s, b.e)), ['א', 'שלום', 'וברכה', ...para(5).split(' ')]);
  const [shalom, uvracha] = boxes.slice(1, 3);
  assert.ok(shalom.x > uvracha.x, 'Hebrew: the first word is to the right');
  assert.equal(shalom.y, uvracha.y);
  // the merge joins neighbours on a line into one stroke
  assert.equal(mergeBoxes([shalom, uvracha]).length, 1);
});

test('a page knows where its words are, and a highlighted image is drawn from the page text offsets', async () => {
  const spec = { v: 0, i: 0, n: 2, s: 0 };
  const page = await renderSpec(volumes, spec, { fetchLetter });
  const first = page.letters[0];
  assert.ok(!first.pageText.startsWith('א\n'), 'the number line is not part of the page text');
  const inText = page.boxes.filter((b) => b.id === 11);
  assert.ok(inText.length > 10);
  for (const b of inText) assert.match(first.pageText.slice(b.s, b.e), /^\S+$/, `box ${b.s}-${b.e} is a word of the page text`);
  const r = findQuote(first.pageText, 'ובטח ימשיך בלימוד התורה');
  assert.ok(r);
  const deps = { volumes, fetchLetter };
  const plain = await getPageImage(encodeSpec(spec), deps);
  const marked = await getPageImage(encodeSpec(spec), deps, `11:${r[0]}-${r[1]}`);
  assert.equal(marked.subarray(1, 4).toString(), 'PNG');
  assert.ok(!marked.equals(plain), 'the marker changes the image');
  assert.ok((await getPageImage(encodeSpec(spec), deps, `11:${r[0]}-${r[1]}`)).equals(marked), 'cached');
  assert.ok((await getPageImage(encodeSpec(spec), deps, 'garbage')).equals(plain), 'a bad hl is ignored');
  assert.ok((await getPageImage(encodeSpec(spec), deps, '999:0-5')).equals(plain), 'a letter not on the page: nothing to mark');

  const h = highlightsFor({ spec: page.spec, letters: page.letters }, ['ובטח ימשיך בלימוד התורה', 'שלום וברכה', 'לא בעמוד הזה בכלל']);
  assert.equal(h.sourcesTotal, 3);
  assert.equal(h.sourcesFound, 2);
  assert.deepEqual(h.highlights.map((x) => x.id), [11]);
  assert.equal(h.highlights[0].spec, page.spec);
  assert.equal(h.highlights[0].r.length, 4, 'flat [start, end, start, end]');
});

test('the analysis returns the highlights of its sources, cleaned of foreign script', async () => {
  const spec = encodeSpec({ v: 0, i: 0, n: 2, s: 0 });
  const out = await analyze({ spec, letter: 'אבקש ברכה' }, {
    volumes, fetchLetter,
    analyze: async () => ({ sourceLanguage: 'hebrew', replyLanguage: 'he', translation: '', explanation: 'הסבر', keyQuote: 'q', sources: ['ובטח ימשיך בלימוד התורה'], provider: 'test' }),
  });
  assert.equal(out.explanation, 'הסב');
  assert.equal(out.sources, undefined);
  assert.deepEqual(out.highlights.map((h) => h.id), [11]);
  assert.deepEqual([out.sourcesFound, out.sourcesTotal], [1, 1]);
});

test('abbreviations are explained from the tapped sentence alone when the app sends it', async () => {
  const seen = {};
  const run = async (input) => { seen.input = input; return [{ word: 'כ"ק', options: ['כבוד קדושת'] }]; };
  await acronyms({ spec: 'irrelevant', words: ['כ"ק'], sentence: 'במענה על מכתב כ"ק אדמו"ר.' }, { acronyms: run });
  assert.equal(seen.input.context, 'במענה על מכתב כ"ק אדמו"ר.');
  await assert.rejects(acronyms({ spec: 'bad', words: ['כ"ק'], sentence: '' }, { acronyms: run, volumes, fetchLetter }), /PAGE_NOT_FOUND/);
});
