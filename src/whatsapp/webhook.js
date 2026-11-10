import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { answerLetter } from '../letters.js';
import { userMessage } from '../errors.js';

const graph = (path) => `https://graph.facebook.com/${config.whatsapp.graphVersion}/${path}`;

async function send(to, payload) {
  const res = await fetch(graph(`${config.whatsapp.phoneNumberId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload }),
  });
  if (!res.ok) console.error('whatsapp send failed', res.status, await res.text());
}

const sendText = (to, body) => send(to, { type: 'text', text: { body: body.slice(0, 4096) } });

function validSignature(req) {
  if (!config.whatsapp.appSecret) return true; // dev only – set WHATSAPP_APP_SECRET in production
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody || '').digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function formatWhatsAppReply(a) {
  const parts = [`✉️ מענה מאגרות קודש – כרך ${a.volume}, עמוד ${a.page}`];
  if (a.keyQuote) parts.push(`«${a.keyQuote}»`);
  if (a.translation) parts.push(`*תרגום:*\n${a.translation}`);
  parts.push(`*הסבר:*\n${a.explanation}`);
  return parts.join('\n\n');
}

async function handleMessage(msg) {
  if (msg.type !== 'text') {
    return sendText(msg.from, 'כרגע ניתן לכתוב לרבי בהודעת טקסט בלבד 🙏');
  }
  await sendText(msg.from, 'המכתב התקבל. פותחים את אגרות הקודש… ⏳');
  try {
    const a = await answerLetter({ letter: msg.text.body });
    await send(msg.from, {
      type: 'document',
      document: {
        link: `${config.publicBaseUrl}${a.pdfPath}`,
        filename: `igrot-kodesh-vol${a.volume}-p${a.page}.pdf`,
        caption: `אגרות קודש, כרך ${a.volume}, עמוד ${a.page}`,
      },
    });
    await sendText(msg.from, formatWhatsAppReply(a));
  } catch (err) {
    console.error(err);
    await sendText(msg.from, userMessage(err).message);
  }
}

export function whatsappRouter() {
  const router = express.Router();

  // Meta webhook verification
  router.get('/', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && config.whatsapp.verifyToken
      && req.query['hub.verify_token'] === config.whatsapp.verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  router.post('/', (req, res) => {
    if (!validSignature(req)) return res.sendStatus(401);
    res.sendStatus(200); // acknowledge fast; Meta retries otherwise
    if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) return;
    const messages = req.body?.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.messages || []) || []) || [];
    for (const msg of messages) handleMessage(msg).catch((e) => console.error(e));
  });

  return router;
}
