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

function applyMark(found) {
  const [p, start, end] = found;
  if (end <= start) return;
  state.marks[p.dataset.key] = mergeRanges([...(state.marks[p.dataset.key] || []), [start, end]]);
  save();
  getSelection().removeAllRanges();
  paintMarks(p);
  $('hl-bar').hidden = true;
}

// Marker mode: every finished selection is highlighted at once (no button needed).
let markerMode = false;
let lastRange = null;
let markTimer = null;
function setMarkerMode(on) {
  markerMode = on;
  document.body.classList.toggle('marker-mode', on);
  $('hl-mode').textContent = on ? '🖍 מרקר פעיל – לסיום' : '🖍 מצב מרקר';
  $('hl-mode').classList.toggle('on', on);
  $('hl-bar').hidden = !on && !selectedRange();
}
document.addEventListener('selectionchange', () => {
  const found = selectedRange();
  if (found) lastRange = found;
  $('hl-add').hidden = !found;
  $('hl-bar').hidden = !found && !markerMode;
  clearTimeout(markTimer);
  if (markerMode && found) markTimer = setTimeout(() => { const f = selectedRange(); if (f) applyMark(f); }, 900);
});
for (const id of ['hl-add', 'hl-mode']) $(id).addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
$('hl-add').addEventListener('click', () => { const f = selectedRange() || lastRange; if (f) applyMark(f); lastRange = null; });
$('hl-mode').addEventListener('click', () => setMarkerMode(!markerMode));

// ---------- full-screen image ----------
function openLightbox(src, alt) {
  const img = $('lightbox-img');
  img.src = src;
  img.alt = alt;
  img.className = 'fit';
  $('lightbox').hidden = false;
  if (!isNativeApp) history.pushState({ lightbox: true }, ''); // browser "back" closes it
}
function closeLightbox(fromHistory = false) {
  if ($('lightbox').hidden) return false;
  $('lightbox').hidden = true;
  $('lightbox-img').removeAttribute('src');
  if (!isNativeApp && !fromHistory && history.state?.lightbox) history.back();
  return true;
}
window.addEventListener('popstate', () => closeLightbox(true));
$('lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.classList.contains('lightbox-scroll')) closeLightbox(); });
$('lightbox-close-bottom').addEventListener('click', () => closeLightbox());
$('lightbox-img').addEventListener('click', (e) => {
  const img = e.currentTarget;
  img.className = img.className === 'fit' ? '' : img.className === '' ? 'zoom' : 'fit'; // fit → page width → zoomed
});
$('lightbox-close').addEventListener('click', () => closeLightbox());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox(); });

// ---------- device authentication, for hidden letters ----------
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const unlocked = new Set(); // entries revealed in this session
document.addEventListener('visibilitychange', () => { // leaving the app hides them again
  if (document.hidden && unlocked.size) { unlocked.clear(); render(); }
});

/** True if this device can confirm the user (fingerprint, face or screen lock). */
async function canAuthenticate() {
  if (isNativeApp) {
    try { return (await window.Capacitor.registerPlugin('DeviceAuth').isAvailable()).available; } catch { return false; }
  }
  return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false));
}

/** Asks for fingerprint / device code. Resolves true on success. */
async function authenticate(reason) {
  if (isNativeApp) {
    try {
      await window.Capacitor.registerPlugin('DeviceAuth').authenticate({ title: 'מכתבים לרבי', subtitle: reason });
      return true;
    } catch { return false; }
  }
  // Browser: the device's own lock (Windows Hello, Touch ID, Android screen lock) through WebAuthn.
  try {
    let id = localStorage.getItem('mlr-webauthn-id');
    if (!id) {
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'מכתבים לרבי' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'michtavim', displayName: 'מכתבים לרבי' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000,
      } });
      id = b64(cred.rawId);
      localStorage.setItem('mlr-webauthn-id', id);
      return true; // creating it already required the device lock
    }
    await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: unb64(id) }],
      userVerification: 'required',
      timeout: 60000,
    } });
    return true;
  } catch { return false; }
}

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
  const question = entry.locked && !unlocked.has(entry.id) ? '' : entry.q;
  const imageUrl = API ? `${API}${a.imagePath}` : new URL(a.imagePath, location.href).href;
  const text = `${question ? `מכתב לרבי:\n${question}\n\n` : ''}המענה: ${a.title}`;

  let blob = null;
  try {
    const res = await fetch(imageUrl);
    if (res.ok) blob = await res.blob();
  } catch { /* share without the image */ }

  if (isNativeApp) {
    const Share = window.Capacitor.registerPlugin('Share');
    if (blob) {
      try {
        const Filesystem = window.Capacitor.registerPlugin('Filesystem');
        const { uri } = await Filesystem.writeFile({
          path: `share/igrot-kodesh-${Date.now()}.png`, data: await blobToBase64(blob), directory: 'CACHE', recursive: true,
        });
        await Share.share({ title: 'מכתבים לרבי', text, files: [uri], dialogTitle: 'שיתוף המענה' });
        return;
      } catch (e) {
        if (/cancel/i.test(e?.message || '')) return;
        console.warn('image share failed, sharing text and link', e);
      }
    }
    await Share.share({ title: 'מכתבים לרבי', text: `${text}\n${imageUrl}`, dialogTitle: 'שיתוף המענה' });
    return;
  }

  if (blob) {
    const file = new File([blob], 'igrot-kodesh.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: 'מכתבים לרבי', text, files: [file] });
      return;
    }
  }
  if (navigator.share) {
    await navigator.share({ title: 'מכתבים לרבי', text, url: imageUrl });
    return;
  }
  // Desktop browsers without sharing: copy the text and download the image.
  try { await navigator.clipboard.writeText(`${text}\n${imageUrl}`); } catch { /* ignore */ }
  if (blob) {
    const link = el('a', { href: URL.createObjectURL(blob), download: 'igrot-kodesh.png' });
    link.click();
    URL.revokeObjectURL(link.href);
  }
  alert(blob ? 'הטקסט הועתק והתמונה ירדה למכשיר – אפשר להדביק ולצרף אותם בכל אפליקציה.' : 'הטקסט והקישור לתמונה הועתקו.');
}

function shareButton(entry) {
  const btn = el('button', { type: 'button', className: 'link-btn', textContent: '↗ שיתוף' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await shareAnswer(entry);
    } catch (e) {
      if (e?.name !== 'AbortError' && !/cancel/i.test(e?.message || '')) alert(`השיתוף נכשל: ${e?.message || e}`);
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

  const prev = el('button', { type: 'button', className: 'nav-btn', textContent: '→', title: 'האגרת הקודמת' });
  const next = el('button', { type: 'button', className: 'nav-btn', textContent: '←', title: 'האגרת הבאה' });
  const where = el('span', { className: 'where' });
  const body = el('div', { className: 'letter-body' });
  const box = el('details', { className: 'letters' },
    el('summary', { textContent: `📜 האגרות בעמוד (${list.length})` }),
    el('div', { className: 'pager' }, prev, where, next), // RTL: first = right
    body);

  const paint = () => {
    const l = list[at];
    where.textContent = `אגרת ${l.number} · ${partLabel(l)}`;
    body.textContent = '';
    body.append(
      markable(l.fullText, `L:${l.id ?? l.number}`),
      el('div', { className: 'links' },
        l.id != null && el('a', { href: `${API}/api/igrot/${l.id}.pdf`, target: '_blank', rel: 'noopener', textContent: '📄 PDF' }),
        el('a', { href: l.viewerUrl, target: '_blank', rel: 'noopener', textContent: '🔗 במקור' })));
    const canFetch = (dir) => list[dir === 'prev' ? 0 : list.length - 1].id != null && !ends[dir];
    prev.disabled = at === 0 && !canFetch('prev');
    next.disabled = at === list.length - 1 && !canFetch('next');
  };

  let busy = false;
  async function step(dir) {
    if (busy || (dir === 'prev' ? prev : next).disabled) return;
    const edge = dir === 'prev' ? at === 0 : at === list.length - 1;
    if (!edge) { at += dir === 'prev' ? -1 : 1; paint(); return; }
    const from = list[dir === 'prev' ? 0 : list.length - 1];
    busy = true; prev.disabled = next.disabled = true;
    where.textContent = 'טוען…';
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
    busy = false;
    paint();
  }
  prev.addEventListener('click', () => step('prev'));
  next.addEventListener('click', () => step('next'));

  // swipe: finger to the right = next (the next letter is on the left), to the left = previous
  let touch = null;
  body.addEventListener('touchstart', (e) => {
    touch = getSelection().isCollapsed ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (!touch || markerMode) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx > 0 ? 'next' : 'prev');
  }, { passive: true });

  paint();
  return box;
}

function markerButton() {
  const b = el('button', { type: 'button', className: 'link-btn', textContent: '🖍 מרקר' });
  b.addEventListener('click', () => {
    setMarkerMode(true);
    alert('מצב מרקר: סמנו טקסט באגרת, בהסבר או בתרגום – הוא יודגש. לסיום לחצו על הכפתור הצהוב למעלה.');
  });
  return b;
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
      el('a', { href: API + a.pdfPath, target: '_blank', rel: 'noopener', textContent: '📄 PDF' }),
      shareButton(entry),
      markerButton()),
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

function questionBubble(entry) {
  const hidden = entry.locked && !unlocked.has(entry.id);
  const tools = el('div', { className: 'q-tools' });
  const tool = (label, title, fn) => {
    const b = el('button', { type: 'button', className: 'q-tool', textContent: label, title });
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    tools.append(b);
  };
  tool(entry.collapsed ? '▸' : '▾', entry.collapsed ? 'הרחבת המענה' : 'כיווץ המענה', () => {
    entry.collapsed = !entry.collapsed; save(); render();
  });
  tool(entry.locked ? '🔓' : '🔒', entry.locked ? 'ביטול ההסתרה' : 'הסתרת המכתב', async () => {
    if (!entry.locked) {
      if (!(await canAuthenticate())) {
        alert('במכשיר זה לא הוגדרו טביעת אצבע או נעילת מסך, ולכן אי אפשר להסתיר מכתבים.');
        return;
      }
      entry.locked = true; unlocked.delete(entry.id); save(); render();
    } else if (await authenticate('ביטול הסתרת המכתב')) {
      delete entry.locked; save(); render();
    }
  });

  const content = hidden
    ? el('button', { type: 'button', className: 'locked-q', textContent: '🔒 מכתב מוסתר – לחצו לפתיחה' })
    : el('p', { textContent: entry.q });
  if (hidden) {
    content.addEventListener('click', async () => {
      if (await authenticate('פתיחת מכתב מוסתר')) { unlocked.add(entry.id); render(); }
    });
  }
  return el('div', { className: 'msg me' }, tools, content, time(entry.ts));
}

function entryNodes(entry) {
  const nodes = [questionBubble(entry)];
  if (entry.a && entry.collapsed) {
    const chip = el('button', { type: 'button', className: 'msg them collapsed-a', textContent: `✉️ ${entry.a.title}${entry.fav ? ' ★' : ''} – הרחבה` });
    chip.addEventListener('click', () => { entry.collapsed = false; save(); render(); });
    nodes.push(chip);
  } else if (entry.a) nodes.push(answerBubble(entry));
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
  // the server address is built into the app; the field is only shown if it is missing
  $('server-section').hidden = !!window.MLR_API_BASE;

  // Android back button: close what is open before leaving the app
  AppInfo.addListener('backButton', () => {
    if (closeLightbox()) return;
    if (dialog.open) { dialog.close(); return; }
    if (markerMode) { setMarkerMode(false); return; }
    AppInfo.minimizeApp();
  });
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
