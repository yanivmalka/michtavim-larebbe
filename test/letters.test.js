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
  // random(): the only volume, then letter ב, point at its start, go back far enough to start inside א
  const seq = [0, 0.4, 0, 0.5];
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
  const app = createApp({
    volumes: bookVolumes,
    pages: { volumes: bookVolumes, fetchLetter: fakeFetch },
    open: (vols, opts) => openBook(vols, { ...opts, random: (() => { const q = [0, 0.4, 0, 0.5]; return () => q.shift() ?? 0; })(), fetchLetter: fakeFetch }),
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
    assert.equal(body.explained, false, 'no explanation until asked for');

    const png = await fetch(base + body.imagePath);
    assert.equal(png.headers.get('content-type'), 'image/png');
    const pagePdf = await fetch(base + body.pdfPath);
    assert.equal(pagePdf.headers.get('content-type'), 'application/pdf');
    const letterPdf = await fetch(base + body.letters[1].pdfPath);
    assert.equal(Buffer.from(await letterPdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await fetch(`${base}/api/page/nope.png`)).status, 404);
    // a page that is not cached any more (e.g. after a restart) is drawn again from its link
    const fresh = createApp({ pages: { volumes: bookVolumes, fetchLetter: fakeFetch } }).listen(0);
    try {
      const again = await fetch(`http://127.0.0.1:${fresh.address().port}${body.imagePath}`);
      assert.equal(again.status, 200);
      assert.equal(Buffer.from(await again.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
    } finally {
      fresh.close();
    }

    const bad = await fetch(`${base}/api/letters`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"letter":""}' });
    assert.equal(bad.status, 400);

    const verify = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    assert.equal(verify.status, 403);
  } finally {
    server.close();
  }
});

test('analysis and follow-up questions run only on request, about the page itself', async () => {
  const { encodeSpec } = await import('../src/igrot/openBook.js');
  const spec = encodeSpec({ v: 0, i: 0, n: 2, s: 0 });
  const seen = {};
  const app = createApp({
    ai: {
      volumes: bookVolumes, fetchLetter: fakeFetch,
      analyze: async (input) => { seen.analyze = input; return { sourceLanguage: 'yiddish', replyLanguage: 'he', translation: 'tr', explanation: 'ex', keyQuote: 'q', provider: 'test' }; },
      followUp: async (input) => { seen.followUp = input; return { answer: 'תשובה', provider: 'test' }; },
    },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const r = await post('/api/analysis', { spec, letter: 'אבקש ברכה', replyLanguage: 'he' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).explanation, 'ex');
    assert.match(seen.analyze.igeret, /=== אגרת א[ =]/, 'the AI reads the page the server draws, not text sent by the client');
    assert.equal(seen.analyze.replyLanguage, 'he');

    const f = await post('/api/analysis/followup', { spec, letter: 'אבקש ברכה', analysis: { explanation: 'ex' }, history: [{ q: 'ש1', a: 'ת1' }], question: 'ומה לגבי פרנסה?' });
    assert.equal((await f.json()).answer, 'תשובה');
    assert.match(seen.followUp.context, /הניתוח שנכתב:\nex/);
    assert.deepEqual(seen.followUp.history, [{ q: 'ש1', a: 'ת1' }]);

    assert.equal((await post('/api/analysis', { spec: 'bad', letter: 'אבקש' })).status, 400);
    assert.equal((await post('/api/analysis/followup', { spec, letter: 'x', question: '' })).status, 400);
  } finally {
    server.close();
  }
  // without a key the server says so clearly
  delete process.env.GEMINI_API_KEY;
  const bare = createApp({ ai: { volumes: bookVolumes, fetchLetter: fakeFetch } }).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${bare.address().port}/api/analysis`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec, letter: 'אבקש ברכה' }) });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'AI_NOT_CONFIGURED');
  } finally {
    bare.close();
  }
});

test('GET /api/igrot/:id/:dir pages to the neighbouring letter', async () => {
  const app = createApp({ neighbors: { volumes: bookVolumes, fetch: async (id) => ({ ...fakeLetters[id], text: `טקסט ${id}`, volumeHeading: 'כרך א' }) } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const next = await (await fetch(`${base}/api/igrot/11/next`)).json();
    assert.deepEqual(next.letter, { id: 12, number: 'ב', volumeHeading: 'כרך א', fullText: 'טקסט 12', viewerUrl: 'u12' });
    assert.equal((await (await fetch(`${base}/api/igrot/11/prev`)).json()).letter, null);
    assert.equal((await fetch(`${base}/api/igrot/999/next`)).status, 404);
    assert.equal((await fetch(`${base}/api/igrot/11/sideways`)).status, 400);
  } finally {
    server.close();
  }
});

test('a page is drawn from its spec alone, and bad specs are refused', async () => {
  const { getPageImage } = await import('../src/letters.js');
  const { encodeSpec } = await import('../src/igrot/openBook.js');
  const deps = { volumes: bookVolumes, fetchLetter: fakeFetch };
  const png = await getPageImage(encodeSpec({ v: 0, i: 1, n: 2, s: 0 }), deps); // never rendered before
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(await getPageImage(encodeSpec({ v: 0, i: 2, n: 5, s: 0 }), deps), null); // past the volume
  assert.equal(await getPageImage('not-a-spec', deps), null);
});

test('turning pages forward then back stays in the same volume and returns to the start', async () => {
  const { getTurnedPage } = await import('../src/letters.js');
  const { encodeSpec, decodeSpec } = await import('../src/igrot/openBook.js');
  const deps = { volumes: bookVolumes, fetchLetter: fakeFetch };
  const first = encodeSpec({ v: 0, i: 0, n: 3, s: 0 });
  assert.equal(await getTurnedPage(first, -1, deps), null, 'no page before the first one');
  const next = await getTurnedPage(first, 1, deps);
  const spec = decodeSpec(next.spec, bookVolumes);
  assert.ok(spec.i > 0 || spec.s > 0, 'the next page starts further on');
  assert.match(next.imagePath, /^\/api\/page\/[\w-]+\.png$/);
  const back = decodeSpec((await getTurnedPage(next.spec, -1, deps)).spec, bookVolumes);
  assert.deepEqual([back.i, back.s], [0, 0]);
  assert.equal(await getTurnedPage('bad', 1, deps), undefined);
});

test('WhatsApp reply text includes source, translation and explanation', () => {
  const text = formatWhatsAppReply({ title: 'אגרות קודש, כרך ג, אגרות תו, תז', keyQuote: 'q', translation: 'tr', explanation: 'ex', pdfUrl: 'https://x.test/p.pdf' });
  assert.match(text, /כרך ג, אגרות תו, תז/);
  assert.match(text, /x\.test\/p\.pdf/);
  assert.match(text, /tr/);
  assert.match(text, /ex/);
});
