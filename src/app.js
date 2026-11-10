import express from 'express';
import { answerLetter, getPagePng, getPagePdf, getLetterPdf } from './letters.js';
import { userMessage } from './errors.js';
import { whatsappRouter } from './whatsapp/webhook.js';
import { cors } from './cors.js';

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

  app.get('/api/answers/:id/page.png', (req, res) => {
    const png = getPagePng(req.params.id);
    if (!png) return res.sendStatus(404);
    res.type('image/png').set('Cache-Control', 'private, max-age=86400').send(png);
  });

  const sendPdf = (res, pdf, name) => {
    if (!pdf) return res.sendStatus(404);
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${name}"`).send(pdf);
  };
  app.get('/api/answers/:id/page.pdf', async (req, res, next) => {
    try { sendPdf(res, await getPagePdf(req.params.id), 'igrot-kodesh-page.pdf'); } catch (e) { next(e); }
  });
  app.get('/api/answers/:id/letters/:n.pdf', async (req, res, next) => {
    try { sendPdf(res, await getLetterPdf(req.params.id, Number(req.params.n)), 'igrot-kodesh-letter.pdf'); } catch (e) { next(e); }
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/webhooks/whatsapp', whatsappRouter());
  app.use(express.static(new URL('../public', import.meta.url).pathname));
  return app;
}
