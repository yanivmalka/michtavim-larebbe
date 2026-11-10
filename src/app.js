import express from 'express';
import { answerLetter, getAnswerPdf } from './letters.js';
import { userMessage } from './errors.js';
import { whatsappRouter } from './whatsapp/webhook.js';

export function createApp(deps = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({
    limit: '100kb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

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

  app.get('/api/answers/:id.pdf', (req, res) => {
    const pdf = getAnswerPdf(req.params.id);
    if (!pdf) return res.sendStatus(404);
    res.type('application/pdf').set('Content-Disposition', 'inline').send(pdf);
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/webhooks/whatsapp', whatsappRouter());
  app.use(express.static(new URL('../public', import.meta.url).pathname));
  return app;
}
