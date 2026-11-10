const $ = (id) => document.getElementById(id);
const chat = $('chat'), form = $('composer'), input = $('input'), send = $('send'), lang = $('lang');
const STORE = 'mlr-history-v1';
const isNativeApp = !!window.Capacitor?.isNativePlatform?.();
const SERVER_KEY = 'mlr-server';
const savedServer = () => { try { return localStorage.getItem(SERVER_KEY) || ''; } catch { return ''; } };
let API = (savedServer() || window.MLR_API_BASE || '').replace(/\/$/, '');

/** In the Android app the server address can be set (or changed) by the user. */
function askServer() {
  const value = prompt('כתובת השרת (לדוגמה https://example.com):', API);
  if (value === null) return false;
  const v = value.trim().replace(/\/$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(v)) { alert('כתובת לא תקינה'); return false; }
  API = v;
  try { localStorage.setItem(SERVER_KEY, v); } catch { /* ignore */ }
  return true;
}
const isMobile = matchMedia('(max-width: 600px)').matches;

const store = {
  load() { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } },
  save(items) { try { localStorage.setItem(STORE, JSON.stringify(items.slice(-40))); } catch { /* ignore */ } },
};
let history = store.load();
try { lang.value = localStorage.getItem('mlr-lang') || ''; } catch { /* ignore */ }

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
};
const time = (ts) => el('span', { className: 'time', textContent: new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) });
const scroll = () => chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });

function renderMine(item) {
  chat.append(el('div', { className: 'msg me' }, el('p', { textContent: item.text }), time(item.ts)));
}

function renderAnswer(item) {
  const a = item.answer;
  const pdfLink = el('a', { href: API + a.pdfPath, target: '_blank', rel: 'noopener', textContent: '📄 פתיחת ה-PDF' });
  const links = el('div', { className: 'links' }, pdfLink,
    a.viewerUrl && el('a', { href: a.viewerUrl, target: '_blank', rel: 'noopener', textContent: '🔗 העמוד במאגר' }));
  const frame = !isMobile && !isNativeApp && item.fresh
    ? el('iframe', { className: 'pdf', src: API + a.pdfPath, title: `כרך ${a.volume} עמוד ${a.page}`, loading: 'lazy' })
    : null;
  const translation = a.translation
    ? el('details', { open: true }, el('summary', { textContent: a.sourceLanguage === 'yiddish' ? 'תרגום מאידיש' : 'תרגום' }), el('p', { textContent: a.translation }))
    : null;
  const original = el('details', {}, el('summary', { textContent: 'נוסח המקור' }), el('p', { textContent: a.transcription }));

  chat.append(el('div', { className: 'msg them' },
    el('h3', { textContent: `✉️ אגרות קודש · כרך ${a.volume} · עמוד ${a.page}` }),
    frame, links,
    a.keyQuote && el('div', { className: 'quote', textContent: a.keyQuote }),
    el('h4', { textContent: 'כיצד המענה מתייחס למכתב' }),
    el('p', { textContent: a.explanation }),
    translation, original,
    el('div', { className: 'note', textContent: 'ההסבר הוא הצעה להבנה בלבד ואינו פסק הלכה. לשאלות מעשיות – יש להתייעץ עם רב.' }),
    time(item.ts)));
}

function renderError(text) {
  chat.append(el('div', { className: 'msg them error', textContent: text }));
}

function renderAll() {
  history.forEach((item) => (item.answer ? renderAnswer(item) : renderMine(item)));
  scroll();
}

async function submit(text) {
  if (isNativeApp && !API && !askServer()) return;
  const mine = { text, ts: Date.now() };
  history.push(mine); renderMine(mine); scroll();
  const typing = el('div', { className: 'msg them typing', textContent: 'פותחים את אגרות הקודש…' });
  chat.append(typing); scroll();
  send.disabled = true; $('status').textContent = 'מקליד…';
  try {
    const res = await fetch(`${API}/api/letters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ letter: text, replyLanguage: lang.value || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    typing.remove();
    if (!res.ok) return renderError(data.message || 'אירעה שגיאה. נסו שוב.');
    const item = { answer: data, ts: Date.now() };
    history.push(item); renderAnswer({ ...item, fresh: true });
  } catch {
    typing.remove(); renderError('אין חיבור לשרת. בדקו את החיבור ונסו שוב.');
  } finally {
    send.disabled = false; $('status').textContent = 'מענה מתוך אגרות הקודש';
    store.save(history); scroll();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || send.disabled) return;
  input.value = ''; input.style.height = '';
  submit(text);
});
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); form.requestSubmit(); }
});
lang.addEventListener('change', () => { try { localStorage.setItem('mlr-lang', lang.value); } catch { /* ignore */ } });
$('clear').addEventListener('click', () => {
  if (!confirm('למחוק את השיחה מהמכשיר?')) return;
  history = []; store.save(history);
  chat.querySelectorAll('.msg').forEach((n) => n.remove());
});

renderAll();
if (isNativeApp) {
  const btn = el('button', { className: 'icon-btn', title: 'כתובת השרת', textContent: '⚙' });
  btn.setAttribute('aria-label', 'כתובת השרת');
  btn.addEventListener('click', askServer);
  $('clear').before(btn);
}
if (!isNativeApp && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
