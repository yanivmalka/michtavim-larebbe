import express from 'express';
import { answerLetter, getPageImage, getPagePdf, getLetterPdf, getNeighborLetter, getTurnedPage } from './letters.js';
import { userMessage } from './errors.js';
import { whatsappRouter } from './whatsapp/webhook.js';
import { cors } from './cors.js';
import { lengthStats } from './igrot/lengths.js';
import { loadCatalog } from './igrot/catalog.js';
import { appUpdateRouter } from './appUpdate.js';

export function createApp(deps = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({
    limit: '100kb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

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

  const sendPdf = (res, pdf, name) => {
    if (!pdf) return res.sendStatus(404);
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${name}"`).send(pdf);
  };
  // Pages are addressed by their spec, so these links keep working after restarts.
  app.get('/api/page/:spec.png', async (req, res, next) => {
    try {
      const png = await getPageImage(req.params.spec, deps.pages);
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
  app.use(express.static(new URL('../public', import.meta.url).pathname));
  return app;
}
