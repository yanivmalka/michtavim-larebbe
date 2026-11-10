const $ = (id) => document.getElementById(id);
const chat = $('chat'), form = $('composer'), input = $('input'), send = $('send'), lang = $('lang');
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

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.flat().filter(Boolean));
  return node;
};

// ---------- state (kept on this device only) ----------
// entries: one per letter written – { id, q, ts, a?, fav?: { tags: [] } }
// days:    per calendar day – { topic?, open?, archived? }
// marks:   highlighter ranges per text – { key: [[start, end], ...] }
const STORE = 'mlr-state-v3';
const MAX_ENTRIES = 80;
const TAGS = ['מרגש', 'מדהים', 'מדויק', 'מחזק', 'מפתיע', 'ברכה'];

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s?.entries) return { days: {}, marks: {}, ...s };
  } catch { /* fall through */ }
  const state = { entries: [], days: {}, marks: {} };
  try { // migrate the older flat history: [{ text, ts }, { answer, question, ts }, ...]
    const old = JSON.parse(localStorage.getItem('mlr-history-v2')) || [];
    for (const item of old) {
      if (item.answer) {
        const last = state.entries.at(-1);
        if (last && !last.a) last.a = item.answer;
        else state.entries.push({ id: `m${item.ts}`, q: item.question || '', ts: item.ts, a: item.answer });
      } else if (item.text) {
        state.entries.push({ id: `m${item.ts}`, q: item.text, ts: item.ts });
      }
    }
  } catch { /* ignore */ }
  return state;
}
const state = loadState();

function save() {
  // keep favourites forever; trim the oldest of the rest
  const extra = state.entries.filter((e) => !e.fav).length - MAX_ENTRIES;
  if (extra > 0) {
    let drop = extra;
    state.entries = state.entries.filter((e) => e.fav || drop-- <= 0);
  }
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}

try { lang.value = localStorage.getItem('mlr-lang') || ''; } catch { /* ignore */ }

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayLabel = (key) => {
  if (key === dayKey(Date.now())) return 'היום';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' });
};
const time = (ts) => el('span', { className: 'time', textContent: new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) });
const scrollDown = () => chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });

// ---------- highlighter ----------
function mergeRanges(ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** A paragraph whose text can be marked; marks are stored under `key`. */
function markable(text, key) {
  const p = el('p', { className: 'hl' });
  p.dataset.key = key;
  p.dataset.text = text;
  paintMarks(p);
  return p;
}

function paintMarks(p) {
  const text = p.dataset.text;
  const ranges = state.marks[p.dataset.key] || [];
  p.textContent = '';
  let pos = 0;
  ranges.forEach(([s, e], i) => {
    if (s > pos) p.append(text.slice(pos, s));
    const m = el('mark', { textContent: text.slice(s, e), title: 'לחיצה מסירה את ההדגשה' });
    m.addEventListener('click', () => {
      if (!getSelection().isCollapsed) return;
      state.marks[p.dataset.key].splice(i, 1);
      if (!state.marks[p.dataset.key].length) delete state.marks[p.dataset.key];
      save();
      paintMarks(p);
    });
    p.append(m);
    pos = e;
  });
  if (pos < text.length) p.append(text.slice(pos));
}

/** The current selection as [paragraph, start, end] if it lies inside one markable paragraph. */
function selectedRange() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const p = (node.nodeType === 1 ? node : node.parentElement)?.closest('.hl');
  if (!p) return null;
  const before = document.createRange();
  before.selectNodeContents(p);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return [p, start, start + range.toString().length];
}

document.addEventListener('selectionchange', () => { $('hl-bar').hidden = !selectedRange(); });
$('hl-add').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection alive
$('hl-add').addEventListener('click', () => {
  const found = selectedRange();
  if (!found) return;
  const [p, start, end] = found;
  state.marks[p.dataset.key] = mergeRanges([...(state.marks[p.dataset.key] || []), [start, end]]);
  save();
  getSelection().removeAllRanges();
  paintMarks(p);
});

// ---------- full-screen image ----------
function openLightbox(src, alt) {
  const img = $('lightbox-img');
  img.src = src;
  img.alt = alt;
  img.className = 'fit';
  $('lightbox').hidden = false;
}
const closeLightbox = () => { $('lightbox').hidden = true; $('lightbox-img').removeAttribute('src'); };
$('lightbox-img').addEventListener('click', (e) => {
  const img = e.currentTarget;
  img.className = img.className === 'fit' ? '' : img.className === '' ? 'zoom' : 'fit'; // fit → page width → zoomed
});
$('lightbox-close').addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox(); });

// ---------- sharing ----------
const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

/** Shares the question text together with the image of the page that answered it. */
async function shareAnswer(entry) {
  const a = entry.a;
  const text = `${entry.q ? `מכתב לרבי:\n${entry.q}\n\n` : ''}המענה: ${a.title}`;
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

function shareButton(entry) {
  const btn = el('button', { type: 'button', className: 'link-btn', textContent: '↗ שיתוף' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await shareAnswer(entry);
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

// ---------- favourites ----------
function favRow(entry) {
  const row = el('div', { className: 'fav-row' });
  const paint = () => {
    row.textContent = '';
    const star = el('button', { type: 'button', className: 'star', textContent: entry.fav ? '★' : '☆', title: entry.fav ? 'הסרה מהמועדפים' : 'שמירה במועדפים' });
    star.setAttribute('aria-pressed', String(!!entry.fav));
    star.addEventListener('click', () => {
      if (entry.fav) delete entry.fav; else entry.fav = { tags: [] };
      save(); paint();
    });
    row.append(star);
    if (!entry.fav) return;
    const all = [...new Set([...TAGS, ...entry.fav.tags])];
    for (const tag of all) {
      const on = entry.fav.tags.includes(tag);
      const chip = el('button', { type: 'button', className: `chip${on ? ' on' : ''}`, textContent: tag });
      chip.addEventListener('click', () => {
        entry.fav.tags = on ? entry.fav.tags.filter((t) => t !== tag) : [...entry.fav.tags, tag];
        save(); paint();
      });
      row.append(chip);
    }
    const add = el('button', { type: 'button', className: 'chip', textContent: '+' , title: 'תיאור משלך' });
    add.addEventListener('click', () => {
      const tag = (prompt('תיאור משלך:') || '').trim().slice(0, 20);
      if (tag && !entry.fav.tags.includes(tag)) { entry.fav.tags.push(tag); save(); paint(); }
    });
    row.append(add);
  };
  paint();
  return row;
}

// ---------- letters of the page: one at a time, previous / next ----------
const partLabel = (l) => (l.onPage === false ? 'מחוץ לעמוד שנפתח'
  : l.startsOnPage && l.endsOnPage ? 'אגרת שלמה בעמוד'
    : l.startsOnPage ? 'תחילתה בעמוד, ממשיכה בעמוד הבא'
      : l.endsOnPage ? 'סופה בעמוד, התחילה בעמוד הקודם' : 'קטע ממנה בעמוד');

function lettersPager(a) {
  const list = (a.letters || []).map((l) => ({ ...l }));
  if (!list.length) return null;
  let at = 0;
  const ends = { prev: false, next: false }; // reached the beginning / end of the book

  const prev = el('button', { type: 'button', textContent: '→ הקודם' });
  const next = el('button', { type: 'button', textContent: 'הבא ←' });
  const where = el('div', { className: 'where' });
  const body = el('div');
  const box = el('details', { className: 'letters' },
    el('summary', { textContent: `האגרות בעמוד (${list.length}) – קריאה ודפדוף` }),
    el('div', { className: 'pager' }, prev, where, next), // RTL: first = right
    body);

  const paint = () => {
    const l = list[at];
    where.textContent = `אגרת ${l.number}`;
    where.append(el('span', { textContent: partLabel(l) }));
    body.textContent = '';
    body.append(
      markable(l.fullText, `L:${l.id ?? l.number}`),
      el('div', { className: 'links' },
        l.pdfPath && el('a', { href: API + l.pdfPath, target: '_blank', rel: 'noopener', textContent: '📄 PDF של האגרת' }),
        el('a', { href: l.viewerUrl, target: '_blank', rel: 'noopener', textContent: '🔗 במקור' })));
    const canFetch = (dir) => list[dir === 'prev' ? 0 : list.length - 1].id != null && !ends[dir];
    prev.disabled = at === 0 && !canFetch('prev');
    next.disabled = at === list.length - 1 && !canFetch('next');
  };

  async function step(dir) {
    const edge = dir === 'prev' ? at === 0 : at === list.length - 1;
    if (!edge) { at += dir === 'prev' ? -1 : 1; paint(); return; }
    const from = list[dir === 'prev' ? 0 : list.length - 1];
    prev.disabled = next.disabled = true;
    try {
      const res = await fetch(`${API}/api/igrot/${from.id}/${dir}`);
      const { letter } = res.ok ? await res.json() : {};
      if (letter) {
        letter.onPage = false;
        if (dir === 'prev') list.unshift(letter); else { list.push(letter); at += 1; }
      } else if (res.ok) {
        ends[dir] = true;
      } else {
        alert('לא ניתן היה לטעון את האגרת. נסו שוב.');
      }
    } catch {
      alert('אין חיבור לשרת.');
    }
    paint();
  }
  prev.addEventListener('click', () => step('prev'));
  next.addEventListener('click', () => step('next'));
  paint();
  return box;
}

// ---------- rendering ----------
function answerBubble(entry) {
  const a = entry.a;
  const img = el('img', { className: 'page-img', src: API + a.imagePath, alt: `עמוד מאגרות קודש, ${a.volumeHeading}`, loading: 'lazy' });
  img.addEventListener('click', () => openLightbox(img.src, img.alt));
  img.addEventListener('error', () => img.replaceWith(el('div', { className: 'note', textContent: 'תמונת העמוד אינה זמינה עוד (נשמרת בשרת לזמן מוגבל). האגרות עצמן שמורות כאן למטה.' })));

  return el('div', { className: 'msg them' },
    el('h3', { textContent: `✉️ אגרות קודש · ${a.volumeHeading}` }),
    img,
    el('div', { className: 'links' },
      el('a', { href: API + a.pdfPath, target: '_blank', rel: 'noopener', textContent: '📄 הורדת העמוד כ-PDF' }),
      shareButton(entry)),
    favRow(entry),
    a.keyQuote && el('div', { className: 'quote', textContent: a.keyQuote }),
    ...(a.explained === false
      ? [el('div', { className: 'note', textContent: 'התרגום וההסבר אינם זמינים כרגע. העמוד והאגרות שבו מוצגים במלואם.' })]
      : [el('h4', { textContent: 'כיצד המענה מתייחס למכתב' }), markable(a.explanation || '', `E:${entry.id}`)]),
    a.translation && el('details', { open: true },
      el('summary', { textContent: a.sourceLanguage === 'yiddish' ? 'תרגום מאידיש' : 'תרגום' }),
      markable(a.translation, `T:${entry.id}`)),
    lettersPager(a),
    el('div', { className: 'note', textContent: 'העמוד מורכב מהטקסט המקוון של אגרות הקודש, ועימודו אינו זהה לעימוד הספר המודפס. ההסבר הוא הצעה להבנה בלבד ואינו פסק הלכה; לשאלות מעשיות – יש להתייעץ עם רב.' }),
    time(entry.ts));
}

function entryNodes(entry) {
  const nodes = [el('div', { className: 'msg me' }, el('p', { textContent: entry.q }), time(entry.ts))];
  if (entry.a) nodes.push(answerBubble(entry));
  else if (entry.pending) nodes.push(el('div', { className: 'msg them typing', textContent: 'פותחים את אגרות הקודש…' }));
  else nodes.push(el('div', { className: 'msg them error', textContent: entry.error || 'לא התקבל מענה למכתב זה.' }));
  return nodes;
}

let view = 'main'; // main | fav | archive

function dayGroup(key, entries) {
  const meta = state.days[key] || {};
  const isToday = key === dayKey(Date.now());
  const title = el('summary');
  const paintTitle = () => {
    title.textContent = '';
    title.append(dayLabel(key), meta.topic ? ' · ' : '', meta.topic ? el('b', { textContent: meta.topic }) : '', ` (${entries.length})`);
  };
  paintTitle();
  const setMeta = (patch) => { state.days[key] = Object.assign(meta, patch); save(); };

  const action = (label, fn) => {
    const b = el('button', { type: 'button', className: 'link-btn', textContent: label });
    b.addEventListener('click', fn);
    return b;
  };
  const actions = el('div', { className: 'day-actions' },
    action('✎ נושא', () => {
      const topic = prompt('נושא לשיחות של יום זה:', meta.topic || '');
      if (topic === null) return;
      setMeta({ topic: topic.trim().slice(0, 40) });
      paintTitle();
    }),
    action(meta.archived ? '↩ החזרה מהארכיון' : '🗄 לארכיון', () => { setMeta({ archived: !meta.archived }); render(); }),
    action('🗑 מחיקה', () => {
      if (!confirm('למחוק מהמכשיר את השיחות של יום זה? (מועדפים יישמרו)')) return;
      state.entries = state.entries.filter((e) => dayKey(e.ts) !== key || e.fav);
      if (!state.entries.some((e) => dayKey(e.ts) === key)) delete state.days[key];
      save(); render();
    }));

  const group = el('details', { className: 'day' }, title,
    el('div', { className: 'day-body' }, actions, entries.flatMap(entryNodes)));
  group.open = view !== 'main' || (meta.open ?? isToday);
  group.addEventListener('toggle', () => { if (view === 'main') setMeta({ open: group.open }); });
  return group;
}

function render({ scroll = false } = {}) {
  chat.textContent = '';
  $('view-fav').setAttribute('aria-pressed', String(view === 'fav'));
  $('view-fav').textContent = view === 'fav' ? '★' : '☆';
  $('view-archive').setAttribute('aria-pressed', String(view === 'archive'));

  const visible = state.entries.filter((e) => {
    const archived = !!state.days[dayKey(e.ts)]?.archived;
    if (view === 'fav') return !!e.fav;
    return view === 'archive' ? archived : !archived;
  });

  if (view !== 'main') chat.append(el('div', { className: 'view-title', textContent: view === 'fav' ? '★ מועדפים' : '🗄 ארכיון' }));
  if (view === 'main') {
    chat.append(el('div', { className: 'intro' },
      'כתבו לרבי כפי שכותבים מכתב – מה על הלב, בקשה לברכה או שאלה.', el('br'),
      'בתשובה ייפתח עמוד מאגרות הקודש – עם כל האגרות שבו, תרגום (כשהמענה באידיש) והסבר.'));
  }
  if (!visible.length && view !== 'main') {
    chat.append(el('div', { className: 'empty', textContent: view === 'fav' ? 'עדיין אין מועדפים. לחצו על ☆ בתשובה כדי לשמור אותה.' : 'הארכיון ריק.' }));
  }

  const byDay = new Map();
  for (const e of visible) {
    const k = dayKey(e.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  for (const [key, entries] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) chat.append(dayGroup(key, entries));
  form.hidden = view !== 'main';
  if (scroll) scrollDown();
}

$('view-fav').addEventListener('click', () => { view = view === 'fav' ? 'main' : 'fav'; render(); });
$('view-archive').addEventListener('click', () => { view = view === 'archive' ? 'main' : 'archive'; render(); });

// ---------- sending a letter ----------
async function submit(text) {
  if (isNativeApp && !API && !askServer()) return;
  const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, q: text, ts: Date.now(), pending: true };
  const key = dayKey(entry.ts);
  state.days[key] = { ...state.days[key], archived: false, open: true }; // writing reopens today's group
  state.entries.push(entry);
  render({ scroll: true });
  send.disabled = true; $('status').textContent = 'מקליד…';
  try {
    const res = await fetch(`${API}/api/letters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ letter: text, replyLanguage: lang.value || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) entry.a = data;
    else entry.error = data.message || 'אירעה שגיאה. נסו שוב.';
  } catch {
    entry.error = 'אין חיבור לשרת. בדקו את החיבור ונסו שוב.';
  } finally {
    delete entry.pending;
    send.disabled = false; $('status').textContent = 'מענה מתוך אגרות הקודש';
    save();
    render({ scroll: true });
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

render({ scroll: true });
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
  $('view-fav').before(btn);
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
