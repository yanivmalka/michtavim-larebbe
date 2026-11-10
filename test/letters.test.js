import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../src/igrot/catalog.js';
import { parseLetterHtml, fetchLetter } from '../src/igrot/chabadlibrary.js';
import { openBook } from '../src/igrot/openBook.js';
import { layout, pngsToPdf } from '../src/render/bookPage.js';
import { pageAsText } from '../src/letters.js';
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

test('the bundled catalog covers the Rebbe\'s Igrot Kodesh', () => {
  const cat = loadCatalog();
  assert.ok(cat.length >= 28);
  assert.ok(cat.reduce((n, v) => n + v.letters.length, 0) > 10000);
});

test('parseLetterHtml classifies blocks and decodes entities', () => {
  const { blocks, pages } = parseLetterHtml(SAMPLE_HTML);
  assert.deepEqual(pages, ['א']);
  assert.deepEqual(blocks.map((b) => b.kind), ['date', 'city', 'address', 'text', 'text', 'signature', 'text', 'note']);
  assert.equal(blocks[2].text, 'כבוד הרה"ג\nמוהרר"י ראזין שליט"א');
  assert.match(blocks[4].text, /"בזה"/);
});

test('parseLetterHtml reads the later-volume markup and its notes', () => {
  const html = `<p class=bodytext><div class=pagenumber>י'צב</div></p>\r\n<p class=bodytext><div class=bh>ב"ה, ו' אדר</div></p>
<p class=bodytext><div class=brooklyn>ברוקלין</div></p><p class=bodytext><div class=lichvod>הרה"ג <a name=x>שמעון</a> שי'</div></p>
<p class=bodytext>שלום וברכה!</p><p class=bodytext><div class=text>בנוגע לחוזה.</div></p>`;
  const haoros = `<p class=bodytext><a name=_ftn_399><span><div class=oysbehaoro><b>י'צב</b></div></span></a></p><p class=bodytext><span>שמעון</span>: קנוביץ.</p>`;
  const { blocks, pages } = parseLetterHtml(html, haoros);
  assert.deepEqual(pages, ["י'צב"]);
  assert.deepEqual(blocks.map((b) => b.kind), ['date', 'city', 'address', 'text', 'text', 'note']);
  assert.equal(blocks[2].text, 'הרה"ג שמעון שי\'');
  assert.equal(blocks[5].text, 'שמעון: קנוביץ.');
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

const para = (n) => Array.from({ length: n }, (_, i) => `מילה${i}`).join(' ');
const fakeLetters = {
  11: { letterHeading: 'א', blocks: [{ kind: 'text', text: para(400) }], viewerUrl: 'u11' },
  12: { letterHeading: 'ב', blocks: [{ kind: 'text', text: para(30) }, { kind: 'note', text: 'הערה' }], viewerUrl: 'u12' },
  13: { letterHeading: 'ג', blocks: [{ kind: 'text', text: para(400) }], viewerUrl: 'u13' },
};
const bookVolumes = [{ volume: 1, heading: 'כרך א', letters: [[11, 'א'], [12, 'ב'], [13, 'ג']] }];
const fakeFetch = async (id) => ({ id, text: 'x', ...fakeLetters[id] });

test('openBook lays out a page that can span the end of one letter and the start of the next', async () => {
  // random(): pick letter ב, point at its start, go back far enough to start inside א
  const seq = [0.4, 0, 0.5];
  const page = await openBook(bookVolumes, { random: () => seq.shift() ?? 0, fetchLetter: fakeFetch });
  assert.equal(page.png.subarray(1, 4).toString(), 'PNG');
  const nums = page.letters.map((l) => l.number);
  assert.deepEqual(nums, ['א', 'ב', 'ג']);
  assert.equal(page.letters[0].startsOnPage, false);
  assert.equal(page.letters[0].endsOnPage, true);
  assert.equal(page.letters[1].startsOnPage && page.letters[1].endsOnPage, true);
  assert.equal(page.letters[2].endsOnPage, false);
  assert.ok(!page.letters[1].pageText.includes('הערה'), 'notes are not part of the page');
  assert.match(pageAsText(page.letters), /=== אגרת א \(ההתחלה בעמוד הקודם\) ===/);
});

test('layout paginates a long letter and the pages become a PDF', async () => {
  const flow = [{ kind: 'number', text: 'א', letter: 0 }, { kind: 'text', text: para(900), letter: 0 }];
  const { pages, shown } = layout(flow, { header: { right: 'r', left: 'l' } });
  assert.ok(pages.length >= 2);
  assert.equal(shown.get(0).complete, true);
  const pdf = await pngsToPdf(pages, 't');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('POST /api/letters returns the page, its letters and serves image and PDFs', async () => {
  let seen;
  const app = createApp({
    volumes: bookVolumes,
    open: (vols, opts) => openBook(vols, { ...opts, random: (() => { const q = [0.4, 0, 0.5]; return () => q.shift() ?? 0; })(), fetchLetter: fakeFetch }),
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
    assert.deepEqual(body.letters.map((l) => l.number), ['א', 'ב', 'ג']);
    assert.match(seen.igeret, /=== אגרת ב ===/);
    assert.equal(seen.replyLanguage, 'he');

    const png = await fetch(base + body.imagePath);
    assert.equal(png.headers.get('content-type'), 'image/png');
    const pagePdf = await fetch(base + body.pdfPath);
    assert.equal(pagePdf.headers.get('content-type'), 'application/pdf');
    const letterPdf = await fetch(base + body.letters[1].pdfPath);
    assert.equal(Buffer.from(await letterPdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await fetch(`${base}/api/answers/nope/page.png`)).status, 404);

    const bad = await fetch(`${base}/api/letters`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"letter":""}' });
    assert.equal(bad.status, 400);

    const verify = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    assert.equal(verify.status, 403);
  } finally {
    server.close();
  }
});

test('the page is still returned when the explanation is unavailable', async () => {
  const { answerLetter } = await import('../src/letters.js');
  const a = await answerLetter({ letter: 'שלום וברכה' }, {
    volumes: bookVolumes,
    open: (vols, opts) => openBook(vols, { ...opts, random: () => 0, fetchLetter: fakeFetch }),
    explain: async () => { throw new Error('credit balance too low'); },
  });
  assert.equal(a.explained, false);
  assert.equal(a.explanation, '');
  assert.ok(a.letters.length >= 1);
  assert.match(a.imagePath, /page\.png$/);
});

test('WhatsApp reply text includes source, translation and explanation', () => {
  const text = formatWhatsAppReply({ title: 'אגרות קודש, כרך ג, אגרות תו, תז', keyQuote: 'q', translation: 'tr', explanation: 'ex', pdfUrl: 'https://x.test/p.pdf' });
  assert.match(text, /כרך ג, אגרות תו, תז/);
  assert.match(text, /x\.test\/p\.pdf/);
  assert.match(text, /tr/);
  assert.match(text, /ex/);
});
