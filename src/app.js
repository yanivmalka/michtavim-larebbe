import express from 'express';
import {
  answerLetter, getPageImage, getPagePdf, getLetterPdf, getNeighborLetter, getTurnedPage, analyze, askFollowUp, translateAnalysis, acronyms, answerPhoto, transcribe, summarize, aramaic,
} from './letters.js';
import { userMessage } from './errors.js';
import { whatsappRouter } from './whatsapp/webhook.js';
import { cors } from './cors.js';
import { lengthStats } from './igrot/lengths.js';
import { loadCatalog } from './igrot/catalog.js';
import { appUpdateRouter } from './appUpdate.js';

/** Tiny in-memory limiter: at most `max` calls per key per window. */
function rateLimit({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return true;
  };
}

export function createApp(deps = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Render's proxy: req.ip is the user's address
  const verify = (req, _res, buf) => { req.rawBody = buf; };
  const smallJson = express.json({ limit: '100kb', verify });
  const mediaJson = express.json({ limit: '9mb' }); // a photo or a voice recording, base64
  const MEDIA = new Set(['/api/photo', '/api/transcribe']);
  app.use((req, res, next) => (MEDIA.has(req.path) ? mediaJson : smallJson)(req, res, next));

  app.use('/api', cors());

  app.post('/api/letters', async (req, res) => {
    try {
      const { letter, replyLanguage } = req.body || {};
      const lang = typeof replyLanguage === 'string' && /^[a-z]{2}$/.test(replyLanguage) ? replyLanguage : undefined;
      res.json(await answerLetter({ letter, replyLanguage: lang }, deps));
    } catch (err) {
      const e = userMessage(err);
      if (e.status >= 500) console.error(err);
      res.status(e.status).json({ error: e.code, message: e.message });
    }
  });

  // The previous (dir=prev) or next (dir=next) letter in book order
  app.get('/api/igrot/:id/:dir', async (req, res) => {
    try {
      const offset = { prev: -1, next: 1 }[req.params.dir];
      if (!offset || !/^\d+$/.test(req.params.id)) return res.sendStatus(400);
      const letter = await getNeighborLetter(Number(req.params.id), offset, deps.neighbors);
      if (letter === undefined) return res.sendStatus(404);
      res.json({ letter });
    } catch (err) {
      const e = userMessage(err);
      console.error(err);
      res.status(e.status).json({ error: e.code, message: e.message });
    }
  });

  // explanation + follow-up questions, only when the user asks (protects the free AI quota)
  const aiLimit = rateLimit({ max: Number(process.env.AI_RATE_PER_HOUR || 40), windowMs: 3600e3 });
  const aiRoute = (fn) => async (req, res) => {
    try {
      if (!aiLimit(req.ip)) throw new Error('AI_RATE_LIMIT');
      res.json(await fn(req.body || {}, deps.ai));
    } catch (err) {
      const e = userMessage(err);
      if (e.status >= 500) console.error(err);
      res.status(e.status).json({ error: e.code, message: e.message });
    }
  };
  app.post('/api/analysis', aiRoute((b, d) => analyze(b, d)));
  app.post('/api/analysis/followup', aiRoute((b, d) => askFollowUp(b, d)));
  app.post('/api/analysis/translate', aiRoute((b, d) => translateAnalysis(b, d)));
  app.post('/api/acronyms', aiRoute((b, d) => acronyms(b, d)));
  // a photo of a printed page → that page from the library; a voice recording → the text of the letter
  app.post('/api/photo', aiRoute((b) => answerPhoto(b, { ...deps.pages, ...deps.photo })));
  app.post('/api/transcribe', aiRoute((b) => transcribe(b, deps.voice)));
  app.post('/api/aramaic', aiRoute((b, d) => aramaic(b, d)));
  // a name for the chat + a line for the minimized letter: light, and limited apart from the analysis quota
  const sumLimit = rateLimit({ max: Number(process.env.SUMMARY_RATE_PER_HOUR || 60), windowMs: 3600e3 });
  app.post('/api/summary', async (req, res) => {
    try {
      if (!sumLimit(req.ip)) throw new Error('AI_RATE_LIMIT');
      res.json(await summarize(req.body || {}, deps.ai));
    } catch (err) {
      const e = userMessage(err);
      res.status(e.status).json({ error: e.code, message: e.message });
    }
  });

  const sendPdf = (res, pdf, name) => {
    if (!pdf) return res.sendStatus(404);
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${name}"`).send(pdf);
  };
  // Pages are addressed by their spec, so these links keep working after restarts.
  // ?hl=<letter id>:<start>-<end>,… marks those words of the page text, as with a highlighter.
  // ?side=right|left gives one page of a spread.
  app.get('/api/page/:spec.png', async (req, res, next) => {
    try {
      const png = await getPageImage(req.params.spec, deps.pages, typeof req.query.hl === 'string' ? req.query.hl : '', typeof req.query.side === 'string' ? req.query.side : '');
      if (!png) return res.sendStatus(404);
      res.type('image/png').set('Cache-Control', 'public, max-age=604800').send(png);
    } catch (e) { next(e); }
  });
  // turning the page: GET /api/page/<spec>/next or /prev
  app.get('/api/page/:spec/:dir', async (req, res, next) => {
    try {
      const dir = { next: 1, prev: -1 }[req.params.dir];
      if (!dir) return res.sendStatus(400);
      const page = await getTurnedPage(req.params.spec, dir, deps.pages);
      if (page === undefined) return res.sendStatus(404);
      res.json({ page });
    } catch (e) { next(e); }
  });
  app.get('/api/page/:spec.pdf', async (req, res, next) => {
    try { sendPdf(res, await getPagePdf(req.params.spec, deps.pages), 'igrot-kodesh-page.pdf'); } catch (e) { next(e); }
  });
  app.get('/api/igrot/:id.pdf', async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.sendStatus(400);
      sendPdf(res, await getLetterPdf(Number(req.params.id), deps.pages), 'igrot-kodesh-letter.pdf');
    } catch (e) { next(e); }
  });

  app.use('/api/app', appUpdateRouter(deps.appUpdate));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/stats', (_req, res) => {
    const total = loadCatalog().reduce((n, v) => n + v.letters.length, 0);
    res.json({ letterLengths: lengthStats(total) });
  });
  app.use('/webhooks/whatsapp', whatsappRouter());
  const publicDir = new URL('../public', import.meta.url).pathname;
  // links to shared conversations: the page reads the code from the address
  app.get('/join/:code', (_req, res) => res.sendFile(`${publicDir}/index.html`));
  // lets Android open these links straight in the app (App Links)
  app.get('/.well-known/assetlinks.json', (_req, res) => res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.michtavim.larebbe',
      sha256_cert_fingerprints: (process.env.ANDROID_CERT_SHA256 || 'A1:31:8E:1B:F5:2E:7B:E3:D0:55:3D:89:33:CE:B7:9D:6A:2A:9F:A8:63:62:D0:D1:B6:DE:4E:32:B8:3F:98:BB').split(','),
    },
  }]));
  app.use(express.static(publicDir));
  return app;
}
