const $ = (id) => document.getElementById(id);
const chat = $('chat'), form = $('composer'), input = $('input'), send = $('send'), lang = $('lang');
const STORE = 'mlr-history-v2';
const isNativeApp = !!window.Capacitor?.isNativePlatform?.();
const SERVER_KEY = 'mlr-server';
const savedServer = () => { try { return localStorage.getItem(SERVER_KEY) || ''; } catch { return ''; } };
let API = (savedServer() || window.MLR_API_BASE || '').replace(/\/$/, '');

/** In the Android app the server address can be set (or changed) by the user. */
function setServer(value) {
  const v = String(value || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(v)) { alert('כתובת לא תקינה'); return false; }
  API = v;
  try { localStorage.setItem(SERVER_KEY, v); } catch { /* ignore */ }
  return true;
}
function askServer() {
  const value = prompt('כתובת השרת (לדוגמה https://example.com):', API);
  return value !== null && setServer(value);
}

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

const partLabel = (l) => (l.startsOnPage && l.endsOnPage ? 'אגרת שלמה'
  : l.startsOnPage ? 'תחילת האגרת (ממשיכה בעמוד הבא)'
    : l.endsOnPage ? 'סוף האגרת (התחילה בעמוד הקודם)' : 'קטע מהאגרת');

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

/** Shares the question text together with the image of the page that answered it. */
async function shareAnswer(item) {
  const a = item.answer;
  const text = `${item.question ? `מכתב לרבי:\n${item.question}\n\n` : ''}המענה: ${a.title}`;
  const res = await fetch(API + a.imagePath);
  if (!res.ok) throw new Error('IMAGE_GONE');
  const blob = await res.blob();

  if (isNativeApp) {
    const Filesystem = window.Capacitor.registerPlugin('Filesystem');
    const Share = window.Capacitor.registerPlugin('Share');
    const { uri } = await Filesystem.writeFile({
      path: 'share/igrot-kodesh.png', data: await blobToBase64(blob), directory: 'CACHE', recursive: true,
    });
    await Share.share({ title: 'מכתבים לרבי', text, files: [uri], dialogTitle: 'שיתוף המענה' });
    return;
  }
  const file = new File([blob], 'igrot-kodesh.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ title: 'מכתבים לרבי', text, files: [file] });
    return;
  }
  // Desktop browsers without file sharing: copy the text and download the image.
  try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  const link = el('a', { href: URL.createObjectURL(blob), download: 'igrot-kodesh.png' });
  link.click();
  URL.revokeObjectURL(link.href);
  alert('הטקסט הועתק והתמונה ירדה למכשיר – אפשר להדביק ולצרף אותם בכל אפליקציה.');
}

function shareButton(item) {
  const btn = el('button', { type: 'button', className: 'link-btn', textContent: '↗ שיתוף' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await shareAnswer(item);
    } catch (e) {
      if (e?.name !== 'AbortError' && !/cancel/i.test(e?.message || '')) {
        alert(e?.message === 'IMAGE_GONE' ? 'תמונת העמוד אינה זמינה עוד בשרת.' : 'השיתוף נכשל. נסו שוב.');
      }
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

function renderAnswer(item) {
  const a = item.answer;
  const img = el('img', { className: 'page-img', src: API + a.imagePath, alt: `עמוד מאגרות קודש, ${a.volumeHeading}`, loading: 'lazy' });
  img.addEventListener('click', () => window.open(API + a.imagePath, '_blank', 'noopener'));
  img.addEventListener('error', () => img.replaceWith(el('div', { className: 'note', textContent: 'תמונת העמוד אינה זמינה עוד (נשמרת בשרת לזמן מוגבל).' })));

  const translation = a.translation
    ? el('details', { open: true }, el('summary', { textContent: a.sourceLanguage === 'yiddish' ? 'תרגום מאידיש' : 'תרגום' }), el('p', { textContent: a.translation }))
    : null;

  const letters = el('div', { className: 'letters' }, el('h4', { textContent: 'האגרות בעמוד' }),
    ...(a.letters || []).map((l) => el('div', { className: 'letter' },
      el('div', { className: 'letter-head' }, el('b', { textContent: `אגרת ${l.number}` }), el('span', { textContent: ` · ${partLabel(l)}` })),
      el('details', {}, el('summary', { textContent: 'הצגת האגרת המלאה' }), el('p', { textContent: l.fullText })),
      el('div', { className: 'links' },
        el('a', { href: API + l.pdfPath, target: '_blank', rel: 'noopener', textContent: '📄 PDF של האגרת' }),
        el('a', { href: l.viewerUrl, target: '_blank', rel: 'noopener', textContent: '🔗 במקור' })))));

  chat.append(el('div', { className: 'msg them' },
    el('h3', { textContent: `✉️ אגרות קודש · ${a.volumeHeading}` }),
    img,
    el('div', { className: 'links' },
      el('a', { href: API + a.pdfPath, target: '_blank', rel: 'noopener', textContent: '📄 הורדת העמוד כ-PDF' }),
      shareButton(item)),
    a.keyQuote && el('div', { className: 'quote', textContent: a.keyQuote }),
    ...(a.explained === false
      ? [el('div', { className: 'note', textContent: 'התרגום וההסבר אינם זמינים כרגע. העמוד והאגרות שבו מוצגים במלואם.' })]
      : [el('h4', { textContent: 'כיצד המענה מתייחס למכתב' }), el('p', { textContent: a.explanation })]),
    translation,
    letters,
    el('div', { className: 'note', textContent: 'העמוד מורכב מהטקסט המקוון של אגרות הקודש, ועימודו אינו זהה לעימוד הספר המודפס. ההסבר הוא הצעה להבנה בלבד ואינו פסק הלכה; לשאלות מעשיות – יש להתייעץ עם רב.' }),
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
    const item = { answer: data, question: text, ts: Date.now() };
    history.push(item); renderAnswer(item);
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
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); form.requestSubmit(); }
});
lang.addEventListener('change', () => { try { localStorage.setItem('mlr-lang', lang.value); } catch { /* ignore */ } });
$('clear').addEventListener('click', () => {
  if (!confirm('למחוק את השיחה מהמכשיר?')) return;
  history = []; store.save(history);
  chat.querySelectorAll('.msg').forEach((n) => n.remove());
});

renderAll();
if (isNativeApp) setupNativeApp();
if (!isNativeApp && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- Android app: settings and updates ----------
async function setupNativeApp() {
  const Cap = window.Capacitor;
  const AppInfo = Cap.registerPlugin('App');
  const Updater = Cap.registerPlugin('AppUpdater');
  const dialog = $('settings');
  const status = (t) => { $('update-status').textContent = t; };
  let current = { build: 0, version: '' };
  let latest = null;

  try {
    const info = await AppInfo.getInfo();
    current = { build: Number(info.build) || 0, version: info.version };
    $('app-version').textContent = info.version;
  } catch { /* plugin missing – keep defaults */ }

  const btn = el('button', { className: 'icon-btn', title: 'הגדרות ועדכונים', textContent: '⚙' });
  btn.setAttribute('aria-label', 'הגדרות ועדכונים');
  btn.addEventListener('click', () => { $('server-input').value = API; dialog.showModal(); });
  $('clear').before(btn);
  $('server-save').addEventListener('click', () => { if (setServer($('server-input').value)) status('הכתובת נשמרה.'); });

  try { $('auto-check').checked = localStorage.getItem('mlr-auto-update') !== 'off'; } catch { /* ignore */ }
  $('auto-check').addEventListener('change', (e) => {
    try { localStorage.setItem('mlr-auto-update', e.target.checked ? 'on' : 'off'); } catch { /* ignore */ }
  });

  async function check({ quiet = false } = {}) {
    if (!API) { if (!quiet) status('יש להגדיר קודם את כתובת השרת.'); return; }
    if (!quiet) status('בודק…');
    try {
      const res = await fetch(`${API}/api/app/latest`, { cache: 'no-store' });
      const v = await res.json();
      if (!v.available) { if (!quiet) status('לא נמצאה גרסה בשרת.'); return; }
      if (v.versionCode > current.build) {
        latest = v;
        status(`גרסה חדשה זמינה: ${v.versionName} (מותקנת: ${current.version || current.build}).`);
        $('install-update').hidden = false;
        $('update-text').textContent = `גרסה חדשה ${v.versionName} זמינה`;
        $('update-banner').hidden = false;
      } else if (!quiet) {
        status(`האפליקציה מעודכנת (${current.version}).`);
        $('install-update').hidden = true;
      }
    } catch {
      if (!quiet) status('לא ניתן היה לבדוק עדכונים. בדקו את החיבור ואת כתובת השרת.');
    }
  }

  async function install() {
    if (!latest) return;
    const { allowed } = await Updater.canInstall();
    if (!allowed) {
      status('יש לאשר לאפליקציה להתקין עדכונים, ואז ללחוץ שוב על "הורדה והתקנה".');
      await Updater.openInstallSettings();
      return;
    }
    const bar = $('update-progress');
    bar.hidden = false; bar.value = 0;
    $('install-update').disabled = true;
    status('מוריד את העדכון…');
    const sub = await Updater.addListener('progress', ({ percent }) => { bar.value = percent; status(`מוריד… ${percent}%`); });
    try {
      await Updater.downloadAndInstall({ url: `${API}${latest.downloadPath}` });
      status('ההורדה הסתיימה – אשרו את ההתקנה בחלון שנפתח.');
    } catch (e) {
      status(e?.code === 'INSTALL_NOT_ALLOWED' ? 'יש לאשר התקנת עדכונים להגדרות האפליקציה.' : 'ההורדה נכשלה. נסו שוב.');
    } finally {
      sub.remove();
      $('install-update').disabled = false;
    }
  }

  $('check-update').addEventListener('click', () => check());
  $('install-update').addEventListener('click', install);
  $('update-now').addEventListener('click', () => { $('server-input').value = API; dialog.showModal(); install(); });

  if ($('auto-check').checked) check({ quiet: true });
}
