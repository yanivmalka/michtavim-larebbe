import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawLetter, loadCatalog } from '../src/igrot/catalog.js';
import { parseLetterHtml, fetchLetter } from '../src/igrot/chabadlibrary.js';
import { renderLetterPdf } from '../src/pdf/letterPdf.js';
import { createApp } from '../src/app.js';
import { formatWhatsAppReply } from '../src/whatsapp/webhook.js';

const volumes = [
  { volume: 1, heading: 'כרך א', letters: [[11, 'א'], [12, 'ב']] },
  { volume: 2, heading: 'כרך ב', letters: [[21, 'קסט']] },
];

const SAMPLE_HTML = `<div class=pagenumber>א</div>\r\n<p class=igroys_bsd>כ"א אדר פ"ח</p>\r\n<p class=igroys_city>ריגא</p>
<p class=igroys_address>כבוד הרה"ג<br>\r\nמוהרר"י ראזין שליט"א</p>
<p class=igroys_text>שלום וברכה!</p><p class=igroys_text>מכתבו הגיעני (ברכות נ"ח) &quot;בזה&quot;.</p>
<p class=igroys_signature><b>מנחם שניאורסאהן</b></p><p class=igroys_text>M. Schneersohn</p>
<h4 class=igroys_comment_number><i><b>א</b></i></h4><p class=igroys_text>הערה ראשונה.</p>`;

test('drawLetter picks every letter with equal weight', () => {
  assert.equal(drawLetter(volumes, () => 0).id, 11);
  assert.equal(drawLetter(volumes, () => 0.5).id, 12);
  assert.deepEqual(drawLetter(volumes, () => 0.99), { volume: 2, volumeHeading: 'כרך ב', id: 21, letterHeading: 'קסט' });
  assert.throws(() => drawLetter([]), /CATALOG_EMPTY/);
});

test('the bundled catalog covers the Rebbe\'s Igrot Kodesh', () => {
  const cat = loadCatalog();
  assert.ok(cat.length >= 28);
  assert.ok(cat.reduce((n, v) => n + v.letters.length, 0) > 10000);
});

test('parseLetterHtml classifies blocks and decodes entities', () => {
  const { blocks, pages } = parseLetterHtml(SAMPLE_HTML);
  assert.deepEqual(pages, ['א']);
  assert.deepEqual(blocks.map((b) => b.kind), ['date', 'city', 'address', 'text', 'text', 'signature', 'text', 'footnote']);
  assert.equal(blocks[2].text, 'כבוד הרה"ג\nמוהרר"י ראזין שליט"א');
  assert.match(blocks[4].text, /"בזה"/);
});

test('fetchLetter reads the library API', async () => {
  let asked;
  const fakeFetch = async (url) => {
    asked = url;
    return Response.json({ content: { type: 'page', tree: [{ heading: 'x' }, { heading: 'כרך א' }, { heading: 'א' }], data: { text: SAMPLE_HTML } } });
  };
  const l = await fetchLetter(1200750002, fakeFetch);
  assert.match(asked, /api\/main\?path=1200750002$/);
  assert.equal(l.volumeHeading, 'כרך א');
  assert.equal(l.letterHeading, 'א');
  assert.match(l.text, /\[הערה\] הערה ראשונה/);
  await assert.rejects(fetchLetter(1, async () => new Response('x', { status: 500 })), /SOURCE_HTTP_500/);
});

test('renderLetterPdf produces a PDF', async () => {
  const { blocks } = parseLetterHtml(SAMPLE_HTML);
  const pdf = await renderLetterPdf({ blocks, volumeHeading: 'כרך א', letterHeading: 'א', viewerUrl: 'https://x.test/1' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('POST /api/letters returns the answer and serves its PDF', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake');
  let seen;
  const app = createApp({
    volumes,
    random: () => 0,
    fetch: async (id) => ({ id, volumeHeading: 'כרך א', letterHeading: 'א', blocks: [], text: 'נוסח', viewerUrl: 'https://x.test/v' }),
    renderPdf: async () => pdf,
    explain: async (input) => {
      seen = input;
      return { sourceLanguage: 'yiddish', replyLanguage: 'he', translation: 'tr', explanation: 'ex', keyQuote: 'q' };
    },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/letters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://localhost' },
      body: JSON.stringify({ letter: 'שלום, אבקש ברכה', replyLanguage: 'he' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://localhost');
    const body = await res.json();
    assert.equal(body.volumeHeading, 'כרך א');
    assert.equal(body.letterNumber, 'א');
    assert.equal(body.original, 'נוסח');
    assert.equal(seen.igeret, 'נוסח');
    assert.equal(seen.replyLanguage, 'he');
    const pdfRes = await fetch(base + body.pdfPath);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await pdfRes.arrayBuffer()), pdf);

    const bad = await fetch(`${base}/api/letters`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"letter":""}' });
    assert.equal(bad.status, 400);

    const verify = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    assert.equal(verify.status, 403);
  } finally {
    server.close();
  }
});

test('WhatsApp reply text includes source, translation and explanation', () => {
  const text = formatWhatsAppReply({ volumeHeading: 'כרך ג', letterNumber: 'תו', keyQuote: 'q', translation: 'tr', explanation: 'ex', viewerUrl: 'https://x.test' });
  assert.match(text, /כרך ג, אגרת תו/);
  assert.match(text, /tr/);
  assert.match(text, /ex/);
});
