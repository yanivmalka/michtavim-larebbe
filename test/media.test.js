import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLetterNumber, findLetter, findVolume, letterIndex } from '../src/igrot/letterNumbers.js';
import { loadCatalog } from '../src/igrot/catalog.js';
import { answerPhoto, transcribe } from '../src/letters.js';
import { createApp } from '../src/app.js';

test('letter numbers are read as printed', () => {
  assert.deepEqual(parseLetterNumber("א'תתקסו"), { n: 1966, stars: 0 });
  assert.deepEqual(parseLetterNumber('אגרת קמא*'), { n: 141, stars: 1 });
  assert.deepEqual(parseLetterNumber("י'תקנח"), { n: 10558, stars: 0 });
  assert.deepEqual(parseLetterNumber('ט״ו'), { n: 15, stars: 0 });
  assert.deepEqual(parseLetterNumber('1966'), { n: 1966, stars: 0 });
  assert.equal(parseLetterNumber('abc'), null);
});

test('every letter of the catalog has its own number, in book order', () => {
  const volumes = loadCatalog();
  const total = volumes.reduce((n, v) => n + v.letters.length, 0);
  assert.equal(letterIndex(volumes).size, total);
  assert.deepEqual(findLetter(volumes, "א'תתקסו"), { v: 6, i: 99 });
  assert.equal(volumes[findLetter(volumes, 'קמא*').v].letters[findLetter(volumes, 'קמא*').i][1], 'קמא*');
  assert.equal(findVolume(volumes, 'חלק יג'), 12);
  assert.equal(findVolume(volumes, '7'), 6);
});

const para = (n) => Array.from({ length: n }, (_, i) => `מילה${i}`).join(' ');
const volumes = [
  { volume: 1, heading: 'כרך א', letters: [[11, 'א'], [12, 'ב'], [13, 'ג']] },
  { volume: 2, heading: 'כרך ב', letters: [[21, 'ד'], [22, 'ה']] },
];
const fetchLetter = async (id) => ({ id, text: 'x', letterHeading: null, blocks: [{ kind: 'text', text: para(40) }], viewerUrl: `u${id}` });
const read = (out) => async () => ({ isIgrot: true, readable: true, volume: '', page: '', letters: [], continuesFromPrevious: false, ...out });

test('a photo opens the letters whose numbers it shows', async () => {
  const a = await answerPhoto({ image: 'AAAA', mimeType: 'image/jpeg' }, { volumes, fetchLetter, readPhoto: read({ volume: 'כרך א', page: '12', letters: ['ב', 'ג'] }) });
  assert.equal(a.volumeHeading, 'כרך א');
  assert.equal(a.letters[0].number, 'ב');
  assert.ok(a.letters.some((l) => l.number === 'ג'));
  assert.equal(a.photo.page, '12');
  assert.match(a.imagePath, /^\/api\/page\/[\w-]+\.png$/);
});

test('a photo that is not a page of Igrot Kodesh, or cannot be read, is refused', async () => {
  const deps = (out) => ({ volumes, fetchLetter, readPhoto: read(out) });
  await assert.rejects(answerPhoto({ image: 'AAAA' }, deps({ isIgrot: false })), /PHOTO_NOT_IGROT/);
  await assert.rejects(answerPhoto({ image: 'AAAA' }, deps({ readable: false, letters: ['א'] })), /PHOTO_UNREADABLE/);
  await assert.rejects(answerPhoto({ image: 'AAAA' }, deps({ letters: ['תתת'] })), /PHOTO_NOT_FOUND/);
  await assert.rejects(answerPhoto({ image: '' }, deps({})), /PHOTO_BAD/);
  await assert.rejects(answerPhoto({ image: 'AAAA', mimeType: 'text/html' }, deps({})), /PHOTO_BAD/);
});

test('a voice recording becomes the text of the letter', async () => {
  const out = await transcribe({ audio: 'AAAA', mimeType: 'audio/webm;codecs=opus' }, { transcribe: async ({ mimeType }) => `שלום ${mimeType}` });
  assert.equal(out.text, 'שלום audio/webm');
  await assert.rejects(transcribe({ audio: 'AAAA', mimeType: 'audio/webm' }, { transcribe: async () => '  ' }), /VOICE_EMPTY/);
  await assert.rejects(transcribe({ audio: 'AAAA', mimeType: 'video/mp4' }, {}), /VOICE_BAD/);
});

test('POST /api/photo and /api/transcribe take large bodies and explain refusals', async () => {
  const app = createApp({
    pages: { volumes, fetchLetter },
    photo: { readPhoto: read({ isIgrot: false }) },
    voice: { transcribe: async () => 'מכתב בקול' },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const big = 'A'.repeat(400_000); // over the 100 kb limit of the other routes
    const photo = await post('/api/photo', { image: big, mimeType: 'image/jpeg' });
    assert.equal(photo.status, 400);
    assert.equal((await photo.json()).error, 'PHOTO_NOT_IGROT');
    const voice = await post('/api/transcribe', { audio: big, mimeType: 'audio/webm' });
    assert.deepEqual(await voice.json(), { text: 'מכתב בקול' });
    assert.equal((await post('/api/letters', { letter: big })).status, 413);
  } finally {
    server.close();
  }
});

test('a letter gets a chat name and a one-line summary; Aramaic is translated', async () => {
  const { summarize, aramaic } = await import('../src/letters.js');
  const s = await summarize({ letter: 'אבקש ברכה לרפואה שלמה' }, { summarize: async () => ({ title: '"ברכה לרפואה"\n', line: 'בקשת ברכה   לרפואה שלמה' }) });
  assert.deepEqual(s, { title: 'ברכה לרפואה', line: 'בקשת ברכה לרפואה שלמה' });
  await assert.rejects(summarize({ letter: '' }, {}), /LETTER_EMPTY/);
  const a = await aramaic({ sentence: 'וכמאמר לית אתר פנוי מיניה', word: 'לית', language: 'xx-bad' }, {
    aramaic: async ({ language }) => ({ isAramaic: true, phrase: 'לית אתר פנוי מיניה', translation: `אין מקום פנוי ממנו (${language})`, words: [{ word: 'לית', meaning: 'אין' }] }),
  });
  assert.equal(a.translation, 'אין מקום פנוי ממנו (he)');
  assert.deepEqual(a.words, [{ word: 'לית', meaning: 'אין' }]);
});
