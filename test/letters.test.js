import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawPage } from '../src/igrot/catalog.js';
import { fetchPage } from '../src/igrot/source.js';
import { createApp } from '../src/app.js';
import { formatWhatsAppReply } from '../src/whatsapp/webhook.js';

const volumes = [
  { volume: 1, sourceId: 'A', firstLetterPage: 10, lastLetterPage: 11 },
  { volume: 2, sourceId: 'B', firstLetterPage: 5, lastLetterPage: 5 },
];

test('drawPage spreads picks over all configured pages', () => {
  assert.deepEqual(drawPage(volumes, () => 0), { volume: 1, sourceId: 'A', page: 10 });
  assert.deepEqual(drawPage(volumes, () => 0.5), { volume: 1, sourceId: 'A', page: 11 });
  assert.deepEqual(drawPage(volumes, () => 0.99), { volume: 2, sourceId: 'B', page: 5 });
  assert.throws(() => drawPage([]), /CATALOG_EMPTY/);
});

test('fetchPage builds URLs from templates and rejects non-PDF bodies', async () => {
  let asked;
  const fakeFetch = async (url) => { asked = url; return new Response('%PDF-1.4 fake'); };
  const r = await fetchPage({ volume: 1, sourceId: '123', page: 7 }, {
    source: 'remote', pagePdfUrl: 'https://x.test/{id}/{page}.pdf', viewerUrl: 'https://x.test/v?r={id}&p={page}', fetch: fakeFetch,
  });
  assert.equal(asked, 'https://x.test/123/7.pdf');
  assert.equal(r.viewerUrl, 'https://x.test/v?r=123&p=7');
  await assert.rejects(fetchPage({ volume: 1, sourceId: '1', page: 1 }, {
    source: 'remote', pagePdfUrl: 'https://x.test/{id}', viewerUrl: '', fetch: async () => new Response('<html>'),
  }), /SOURCE_NOT_PDF/);
});

test('POST /api/letters returns the answer and serves its PDF', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake');
  let seen;
  const app = createApp({
    volumes,
    random: () => 0,
    fetch: async () => ({ pdf, viewerUrl: 'https://x.test/v' }),
    explain: async (input) => {
      seen = input;
      return { sourceLanguage: 'yiddish', replyLanguage: 'he', transcription: 't', translation: 'tr', explanation: 'ex', keyQuote: 'q' };
    },
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/letters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ letter: 'שלום, אבקש ברכה', replyLanguage: 'he' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.volume, 1);
    assert.equal(body.page, 10);
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
  const text = formatWhatsAppReply({ volume: 3, page: 40, keyQuote: 'q', translation: 'tr', explanation: 'ex' });
  assert.match(text, /כרך 3, עמוד 40/);
  assert.match(text, /tr/);
  assert.match(text, /ex/);
});
