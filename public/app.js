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
// convs:   conversations, like chats – { id, title, created, archived?, locked? }
// entries: one per letter written – { id, conv, q, ts, a?, fav?: { tags: [] }, collapsed? }
// marks:   highlighter ranges per text – { key: [[start, end], ...] }
const STORE = 'mlr-state-v4';
const MAX_ENTRIES = 150;
const TAGS = ['מרגש', 'מדהים', 'מדויק', 'מחזק', 'מפתיע', 'ברכה'];
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayLabel = (key) => {
  if (key === dayKey(Date.now())) return 'היום';
  if (key === dayKey(Date.now() - 864e5)) return 'אתמול';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' });
};

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s?.convs) return { marks: {}, ...s };
  } catch { /* fall through */ }
  // migrate v3: day groups (with topic / archived) become conversations
  const state = { convs: [], entries: [], marks: {} };
  try {
    const old = JSON.parse(localStorage.getItem('mlr-state-v3'));
    if (old?.entries) {
      state.marks = old.marks || {};
      const byDay = new Map();
      for (const e of old.entries) {
        const k = dayKey(e.ts);
        if (!byDay.has(k)) {
          const meta = old.days?.[k] || {};
          const conv = { id: newId(), title: meta.topic || dayLabel(k), created: e.ts, archived: !!meta.archived };
          if (old.entries.some((x) => dayKey(x.ts) === k && x.locked)) conv.locked = true;
          state.convs.push(conv);
          byDay.set(k, conv.id);
        }
        const { locked, ...rest } = e;
        state.entries.push({ ...rest, conv: byDay.get(k) });
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

const convById = (id) => state.convs.find((c) => c.id === id);
const entriesOf = (id) => state.entries.filter((e) => e.conv === id);
const lastTs = (c) => Math.max(c.created || 0, c.lastTs || 0, entriesOf(c.id).at(-1)?.ts || 0, ...(state.messages || []).filter((m) => m.conv === c.id).map((m) => m.ts));

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
// Pages seen in the full-screen view: going back shows exactly the page you came from;
// only pages beyond those are asked from the server.
const lb = { pages: [], at: 0, opened: 0, busy: false };
const specOf = (imagePath) => (/\/api\/page\/([\w-]+)\.png$/.exec(imagePath || '') || [])[1];

function paintLightbox() {
  const img = $('lightbox-img');
  const page = lb.pages[lb.at];
  img.src = API + page.imagePath;
  img.className = 'fit';
  $('lightbox').querySelector('.lightbox-scroll').scrollTo(0, 0);
  const offset = lb.at - lb.opened;
  $('lb-where').textContent = lb.busy ? 'טוען…' : offset === 0 ? 'העמוד שנפתח' : offset > 0 ? `${offset} עמודים קדימה` : `${-offset} עמודים אחורה`;
  if (Math.abs(offset) === 1) $('lb-where').textContent = offset > 0 ? 'העמוד הבא' : 'העמוד הקודם';
  $('lb-prev').disabled = lb.busy || (lb.at === 0 && lb.pages[0].first);
  $('lb-next').disabled = lb.busy || (lb.at === lb.pages.length - 1 && lb.pages.at(-1).last);
}

async function turnLightbox(dir) {
  if (lb.busy || !lb.pages.length || !lb.pages[0].spec) return;
  const edge = dir > 0 ? lb.at === lb.pages.length - 1 : lb.at === 0;
  if (!edge) { lb.at += dir; paintLightbox(); return; }
  const from = dir > 0 ? lb.pages.at(-1) : lb.pages[0];
  if (dir > 0 ? from.last : from.first) return;
  lb.busy = true; paintLightbox();
  try {
    const res = await fetch(`${API}/api/page/${from.spec}/${dir > 0 ? 'next' : 'prev'}`);
    const { page } = res.ok ? await res.json() : {};
    if (page) {
      if (dir > 0) { lb.pages.push(page); lb.at += 1; } else { lb.pages.unshift(page); lb.opened += 1; }
    } else if (res.ok) {
      from[dir > 0 ? 'last' : 'first'] = true;
    } else {
      alert('לא ניתן היה לטעון את העמוד. נסו שוב.');
    }
  } catch {
    alert('אין חיבור לשרת.');
  }
  lb.busy = false;
  paintLightbox();
}

function openLightbox(imagePath, alt) {
  const spec = specOf(imagePath);
  lb.pages = [{ spec, imagePath }];
  lb.at = 0; lb.opened = 0; lb.busy = false;
  $('lightbox-img').alt = alt;
  $('lightbox-nav').hidden = !spec; // older answers have no page link to turn from
  paintLightbox();
  $('lightbox').hidden = false;
  if (!isNativeApp) history.pushState({ lightbox: true }, ''); // browser "back" closes it
}
$('lb-prev').addEventListener('click', () => turnLightbox(-1));
$('lb-next').addEventListener('click', () => turnLightbox(1));
{ // swipe on the page: finger to the right = next page (Hebrew book), to the left = previous
  let t = null;
  const area = $('lightbox');
  area.addEventListener('touchstart', (e) => { t = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  area.addEventListener('touchend', (e) => {
    if (!t || $('lightbox-img').className !== 'fit') { t = null; return; } // zoomed: the finger scrolls
    const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y;
    t = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) turnLightbox(dx > 0 ? 1 : -1);
  }, { passive: true });
}
document.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.key === 'ArrowLeft') turnLightbox(1);
  if (e.key === 'ArrowRight') turnLightbox(-1);
});

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

// ---------- device authentication, for locked chats ----------
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
let lockedOpen = false; // locked chats were unlocked in this session
document.addEventListener('visibilitychange', () => { // leaving the app locks them again
  if (document.hidden && lockedOpen) {
    lockedOpen = false;
    if (view.name === 'locked' || (view.name === 'chat' && convById(view.id)?.locked)) view = { name: 'list' };
    render();
  }
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
  const question = entry.q;
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
  img.addEventListener('click', () => openLightbox(a.imagePath, img.alt));
  img.addEventListener('error', () => img.replaceWith(el('div', { className: 'note', textContent: 'תמונת העמוד אינה זמינה עוד (נשמרת בשרת לזמן מוגבל). האגרות עצמן שמורות כאן למטה.' })));

  const more = el('details', { className: 'more' },
    el('summary', { textContent: a.explained === false ? 'פעולות והאגרות שבעמוד' : 'הסבר, תרגום והאגרות שבעמוד' }),
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
    el('div', { className: 'note', textContent: 'העמוד מורכב מהטקסט המקוון של אגרות הקודש, ועימודו אינו זהה לעימוד הספר המודפס. ההסבר הוא הצעה להבנה בלבד ואינו פסק הלכה; לשאלות מעשיות – יש להתייעץ עם רב.' }));
  more.open = !!entry.showMore;
  more.addEventListener('toggle', () => { entry.showMore = more.open; save(); });

  return el('div', { className: 'msg them' },
    el('h3', { textContent: `✉️ אגרות קודש · ${a.volumeHeading}${entry.fav ? ' ★' : ''}` }),
    img,
    more,
    time(entry.ts));
}

// ---------- account, sync and sharing (Firebase, loaded only when needed) ----------
let cloud = null;            // the cloud module, once loaded
let user = null;             // the signed-in user
const convWatchers = new Map(); // conv id → unsubscribe
let convsWatcher = null;
state.messages ||= [];       // chat messages of shared conversations: { id, conv, uid, name, text, ts, replyTo }
const SITE = isNativeApp ? API : location.origin;

async function loadCloud() {
  if (cloud) return cloud;
  const [mod, { firebaseConfig }] = await Promise.all([import('./vendor/cloud.js'), import('./firebase-config.js')]);
  mod.initCloud(firebaseConfig);
  cloud = mod;
  cloud.onUser(onUserChanged);
  try { if (localStorage.getItem('mlr-emulator') === '1') window.__mlrSignInForTests = cloud.signInForTests; } catch { /* ignore */ }
  return cloud;
}

const isShared = (conv) => (conv?.members?.length || 0) > 1;
const isOwner = (conv) => !conv?.cloud || !user || conv.owner === user.uid;
const messagesOf = (id) => state.messages.filter((m) => m.conv === id);

let renderQueued = false;
function renderSoon() { // many snapshots can arrive at once
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // do not redraw under the user's selection (marker) or an open menu
    if (!getSelection().isCollapsed || $('conv-menu').open) { setTimeout(renderSoon, 800); return; }
    render();
  });
}

async function onUserChanged(u) {
  user = u;
  try { localStorage.setItem('mlr-signed-in', u ? '1' : ''); } catch { /* ignore */ }
  paintAccount();
  if (!u) { stopWatching(); return; }
  if ($('account').open) { $('account-status').textContent = ''; $('account').close(); }
  // conversations made on this device before signing in move to the account
  const local = state.convs.filter((c) => !c.cloud);
  for (const c of local) {
    try {
      await cloud.uploadConv({ id: c.id, title: c.title, created: c.created }, entriesOf(c.id).filter((e) => !e.pending));
      Object.assign(c, { cloud: true, owner: u.uid, members: [u.uid] });
    } catch (e) { console.warn('upload failed', c.id, e); }
  }
  save();
  watchAll();
  if (pendingJoin) joinNow();
}

function stopWatching() {
  convsWatcher?.(); convsWatcher = null;
  for (const off of convWatchers.values()) off();
  convWatchers.clear();
}

function watchAll() {
  stopWatching();
  convsWatcher = cloud.watchMyConvs((docs) => {
    const ids = new Set(docs.map((d) => d.id));
    for (const d of docs) {
      const { updated, joinWith, ...fields } = d;
      const local = convById(d.id);
      if (local) Object.assign(local, fields, { cloud: true }); // keeps this device's archived / locked flags
      else state.convs.push({ ...fields, cloud: true });
      if (!convWatchers.has(d.id)) watchOne(d.id);
    }
    // conversations deleted, or that we left / were removed from
    for (const c of state.convs.filter((x) => x.cloud && !ids.has(x.id))) dropConv(c.id);
    save(); renderSoon();
  }, (e) => console.warn('conversations', e));
}

function watchOne(id) {
  convWatchers.set(id, cloud.watchConv(id, {
    onEntries(list) {
      const keep = new Map(entriesOf(id).map((e) => [e.id, e]));
      const merged = list.map((d) => Object.assign(keep.get(d.id) || {}, d, { conv: id })); // keeps fav / collapsed
      const pending = entriesOf(id).filter((e) => e.pending && !list.some((d) => d.id === e.id));
      state.entries = state.entries.filter((e) => e.conv !== id).concat(merged, pending);
      save(); renderSoon();
    },
    onMessages(list) {
      state.messages = state.messages.filter((m) => m.conv !== id).concat(list.map((m) => ({ ...m, conv: id })));
      save(); renderSoon();
    },
    onError: (e) => console.warn('conversation', id, e),
  }));
}

function dropConv(id) {
  convWatchers.get(id)?.(); convWatchers.delete(id);
  state.entries = state.entries.filter((e) => e.conv !== id);
  state.messages = state.messages.filter((m) => m.conv !== id);
  state.convs = state.convs.filter((c) => c.id !== id);
}

// ---- account dialog ----
function paintAccount() {
  $('account-btn').textContent = user ? '👤' : '👤';
  $('account-btn').classList.toggle('on', !!user);
  $('account-in').hidden = !user;
  $('account-out').hidden = !!user;
  if (user) $('account-name').textContent = `${user.displayName || ''} ${user.email ? `(${user.email})` : ''}`.trim();
}
$('account-btn').addEventListener('click', () => { paintAccount(); $('account').showModal(); });
$('sign-in').addEventListener('click', async () => {
  $('account-status').textContent = 'מתחבר…';
  try {
    await loadCloud();
    if (isNativeApp) {
      let Auth;
      try { Auth = window.Capacitor.registerPlugin('FirebaseAuthentication'); await Auth.signInWithGoogle; } catch { Auth = null; }
      const result = Auth ? await Auth.signInWithGoogle().catch((e) => { throw e; }) : null;
      if (!result?.credential?.idToken) throw new Error('NATIVE_SIGN_IN_UNAVAILABLE');
      await cloud.signInWithGoogle(result.credential.idToken);
    } else {
      await cloud.signInWithGoogle();
    }
    $('account-status').textContent = '';
    $('account').close();
  } catch (e) {
    $('account-status').textContent = e?.message === 'NATIVE_SIGN_IN_UNAVAILABLE' || /not implemented/i.test(e?.message || '')
      ? 'ההתחברות באפליקציה תתאפשר בגרסה הבאה. בינתיים אפשר להתחבר באתר.'
      : /popup-closed|cancel/i.test(`${e?.code} ${e?.message}`) ? '' : `ההתחברות נכשלה: ${e?.code || e?.message || e}`;
  }
});
$('sign-out').addEventListener('click', async () => {
  if (!confirm('להתנתק? השיחות של החשבון יוסרו מהמכשיר הזה (הן נשמרות בחשבון).')) return;
  stopWatching();
  for (const c of state.convs.filter((x) => x.cloud)) dropConv(c.id);
  save();
  await cloud?.signOut();
  $('account').close();
  go({ name: 'list' });
});

// ---- joining a shared conversation: link /join/<conv>.<token> ----
let pendingJoin = null;
function readJoinLink(url) {
  const m = /\/join\/([\w-]+)\.([0-9a-f]{32})/.exec(url || '');
  return m ? { id: m[1], token: m[2] } : null;
}
async function joinNow() {
  const j = pendingJoin;
  if (!j) return;
  if (!user) {
    await loadCloud().catch(() => {});
    if (!user) {
      $('account-status').textContent = 'כדי להצטרף לשיחה המשותפת יש להתחבר עם חשבון Google.';
      paintAccount(); $('account').showModal();
      return; // continues after sign-in (onUserChanged)
    }
  }
  pendingJoin = null;
  try {
    if (!convById(j.id)) await cloud.joinConv(j.id, j.token);
    go({ name: 'chat', id: j.id });
  } catch (e) {
    alert('לא ניתן היה להצטרף לשיחה. ייתכן שהקישור בוטל או שגוי.');
    console.warn(e);
  }
}

// ---- reply-to (shared conversations) ----
let replyTo = null;
function setReply(target) {
  replyTo = target;
  $('reply-bar').hidden = !target;
  if (target) { $('reply-text').textContent = `↩ ${target.name}: ${target.text}`; input.focus(); }
}
$('reply-cancel').addEventListener('click', () => setReply(null));
const replyButton = (target) => {
  const b = el('button', { type: 'button', className: 'q-tool', textContent: '↩', title: 'תגובה' });
  b.setAttribute('aria-label', 'תגובה');
  b.addEventListener('click', () => setReply(target));
  return b;
};
const replyQuote = (r) => r && el('div', { className: 'reply-quote' }, el('b', { textContent: r.name }), ` ${r.text}`);
const nameOf = (conv, uid) => conv?.memberInfo?.[uid]?.name || 'משתתף';

function questionBubble(entry, conv) {
  const tools = el('div', { className: 'q-tools' });
  if (entry.a) {
    const b = el('button', { type: 'button', className: 'q-tool', textContent: entry.collapsed ? '▸' : '▾', title: entry.collapsed ? 'הרחבת המענה' : 'כיווץ המענה' });
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', () => { entry.collapsed = !entry.collapsed; save(); render(); });
    tools.append(b);
  }
  const mine = isOwner(conv);
  const who = mine ? 'אני' : nameOf(conv, conv.owner);
  if (isShared(conv)) tools.append(replyButton({ kind: 'entry', id: entry.id, name: who, text: entry.q.slice(0, 80) }));
  return el('div', { className: `msg ${mine ? 'me' : 'them other'}` }, tools,
    !mine && el('div', { className: 'sender', textContent: `✉️ מכתב של ${who}` }),
    el('p', { textContent: entry.q }), time(entry.ts));
}

function messageBubble(m, conv) {
  const mine = user && m.uid === user.uid;
  const tools = el('div', { className: 'q-tools' }, replyButton({ kind: 'message', id: m.id, name: mine ? 'אני' : m.name, text: m.text.slice(0, 80) }));
  if (mine || isOwner(conv)) {
    const del = el('button', { type: 'button', className: 'q-tool', textContent: '🗑', title: 'מחיקת ההודעה' });
    del.addEventListener('click', async () => { if (confirm('למחוק את ההודעה לכולם?')) await cloud.deleteMessage(conv.id, m.id).catch(() => alert('המחיקה נכשלה.')); });
    tools.append(del);
  }
  return el('div', { className: `msg chat-msg ${mine ? 'me' : 'them other'}` }, tools,
    !mine && el('div', { className: 'sender', textContent: m.name }),
    replyQuote(m.replyTo), el('p', { textContent: m.text }), time(m.ts));
}

function entryNodes(entry, conv = convById(entry.conv)) {
  const nodes = [questionBubble(entry, conv)];
  if (entry.a && entry.collapsed) {
    const chip = el('button', { type: 'button', className: 'msg them collapsed-a', textContent: `✉️ ${entry.a.title}${entry.fav ? ' ★' : ''} – הרחבה` });
    chip.addEventListener('click', () => { entry.collapsed = false; save(); render(); });
    nodes.push(chip);
  } else if (entry.a) {
    const bubble = answerBubble(entry);
    if (isShared(conv)) bubble.prepend(el('div', { className: 'q-tools' }, replyButton({ kind: 'answer', id: entry.id, name: 'המענה', text: entry.a.title })));
    nodes.push(bubble);
  } else if (entry.pending) nodes.push(el('div', { className: 'msg them typing', textContent: 'פותחים את אגרות הקודש…' }));
  else nodes.push(el('div', { className: 'msg them error', textContent: entry.error || 'לא התקבל מענה למכתב זה.' }));
  return nodes;
}

// views: list (all chats) | archive | locked | fav | chat (one conversation)
let view = { name: 'list' };
let search = '';

function go(next) {
  view = next;
  search = '';
  $('search').value = '';
  closeConvMenu();
  setReply(null);
  render({ scroll: next.name === 'chat' });
}

const shortTime = (ts) => (dayKey(ts) === dayKey(Date.now())
  ? new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
  : dayKey(ts) === dayKey(Date.now() - 864e5) ? 'אתמול'
    : new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }));

// ---- conversation actions (long press on a row, or ⋮ in a chat) ----
let menuConv = null;
function openConvMenu(conv) {
  menuConv = conv;
  const owner = isOwner(conv);
  $('menu-title').textContent = conv.title;
  $('menu-archive').textContent = conv.archived ? '📤 הוצאה מהארכיון' : '🗄 העברה לארכיון';
  $('menu-lock').textContent = conv.locked ? '🔓 ביטול נעילה' : '🔒 נעילת השיחה (במכשיר זה)';
  $('menu-rename').hidden = !owner;
  $('menu-share').hidden = !owner;
  $('menu-stop-share').hidden = !owner || !(isShared(conv) || conv.inviteToken);
  $('menu-delete').textContent = !conv.cloud ? '🗑 מחיקת השיחה' : owner ? '🗑 מחיקת השיחה לכולם' : '🚪 יציאה מהשיחה';
  const people = isShared(conv) ? (conv.members || []).map((u) => nameOf(conv, u) + (u === conv.owner ? ' (פותח השיחה)' : '')).join(', ') : '';
  $('menu-members').hidden = !people;
  $('menu-members').textContent = people ? `👥 ${people}` : '';
  $('lang').closest('label').hidden = !owner;
  $('conv-menu').showModal();
}
function closeConvMenu() { if ($('conv-menu').open) $('conv-menu').close(); }

$('menu-rename').addEventListener('click', async () => {
  const conv = menuConv;
  const t = prompt('שם השיחה:', conv.title);
  closeConvMenu();
  if (!t || !t.trim()) return;
  conv.title = t.trim().slice(0, 50); save(); render();
  if (conv.cloud) await cloud.renameConv(conv.id, conv.title).catch(() => alert('שינוי השם לא נשמר בחשבון.'));
});
$('menu-archive').addEventListener('click', () => {
  menuConv.archived = !menuConv.archived;
  save(); closeConvMenu();
  if (view.name === 'chat') go({ name: 'list' }); else render();
});
$('menu-lock').addEventListener('click', async () => {
  const conv = menuConv;
  closeConvMenu();
  if (!conv.locked) {
    if (!(await canAuthenticate())) {
      alert('במכשיר זה לא הוגדרו טביעת אצבע או נעילת מסך, ולכן אי אפשר לנעול שיחות.');
      return;
    }
    conv.locked = true; save();
    alert('השיחה ננעלה. היא מופיעה עכשיו רק תחת "שיחות נעולות", שנפתחות בטביעת אצבע או בקוד המכשיר.');
    if (view.name === 'chat') go({ name: 'list' }); else render();
  } else if (lockedOpen || await authenticate('ביטול נעילת השיחה')) {
    delete conv.locked; save(); render();
  }
});
$('menu-share').addEventListener('click', async () => {
  const conv = menuConv;
  closeConvMenu();
  try {
    await loadCloud();
    if (!user) {
      $('account-status').textContent = 'כדי לשתף שיחה יש להתחבר עם חשבון Google.';
      paintAccount(); $('account').showModal();
      return;
    }
    if (!conv.cloud) { alert('השיחה עדיין מסתנכרנת לחשבון. נסו שוב בעוד רגע.'); return; }
    const token = await cloud.inviteToken(conv);
    conv.inviteToken = token;
    const link = `${SITE}/join/${conv.id}.${token}`;
    const text = `הצטרפו לשיחה "${conv.title}" ב"מכתבים לרבי" – תוכלו לראות את המכתבים והמענים ולהגיב:\n${link}`;
    if (isNativeApp) await window.Capacitor.registerPlugin('Share').share({ title: 'מכתבים לרבי', text, dialogTitle: 'שיתוף השיחה' });
    else if (navigator.share) await navigator.share({ title: 'מכתבים לרבי', text });
    else { await navigator.clipboard.writeText(text).catch(() => {}); alert(`הקישור הועתק:\n${link}`); }
  } catch (e) {
    if (!/cancel|abort/i.test(`${e?.name} ${e?.message}`)) alert(`השיתוף נכשל: ${e?.message || e}`);
  }
});
$('menu-stop-share').addEventListener('click', async () => {
  const conv = menuConv;
  closeConvMenu();
  if (!confirm('להפסיק את השיתוף? המשתתפים האחרים יוסרו מהשיחה והקישור יבוטל.')) return;
  await cloud.stopSharing(conv).catch(() => alert('הפעולה נכשלה.'));
});
$('menu-delete').addEventListener('click', async () => {
  const conv = menuConv;
  closeConvMenu();
  const owner = isOwner(conv);
  const question = !conv.cloud ? `למחוק את השיחה "${conv.title}" מהמכשיר?`
    : owner ? `למחוק את השיחה "${conv.title}"? היא תימחק לכל המשתתפים ומכל המכשירים.` : `לצאת מהשיחה "${conv.title}"?`;
  if (!confirm(question)) return;
  try {
    if (conv.cloud) await (owner ? cloud.deleteConv(conv.id) : cloud.leaveConv(conv.id));
  } catch (e) { alert(`הפעולה נכשלה: ${e?.message || e}`); return; }
  dropConv(conv.id);
  save();
  if (view.name === 'chat') go({ name: 'list' }); else render();
});

/** Long press (touch) or right click (mouse) */
function onLongPress(node, fn) {
  let timer = null;
  let fired = false;
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(); });
  node.addEventListener('touchstart', () => { fired = false; timer = setTimeout(() => { fired = true; fn(); }, 550); }, { passive: true });
  for (const ev of ['touchend', 'touchmove', 'touchcancel']) node.addEventListener(ev, () => clearTimeout(timer), { passive: true });
  node.addEventListener('click', (e) => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
}

function convRow(conv) {
  const entries = entriesOf(conv.id);
  const items = [...entries, ...messagesOf(conv.id)].sort((x, y) => x.ts - y.ts);
  const last = items.at(-1);
  const preview = !last ? (conv.lastPreview || 'אין עדיין מכתבים')
    : last.text ? `${user && last.uid === user.uid ? 'אני' : last.name}: ${last.text}`
      : last.a ? `✉️ ${last.a.title}` : last.pending ? 'פותחים את אגרות הקודש…' : last.q;
  const favs = entries.filter((e) => e.fav).length;
  const row = el('button', { type: 'button', className: 'conv' },
    el('span', { className: 'conv-avatar', textContent: conv.locked ? '🔒' : isShared(conv) ? '👥' : '✉️' }),
    el('span', { className: 'conv-main' },
      el('span', { className: 'conv-top' },
        el('b', { className: 'conv-title', textContent: conv.title }),
        el('span', { className: 'conv-time', textContent: shortTime(lastTs(conv)) })),
      el('span', { className: 'conv-bottom' },
        el('span', { className: 'conv-preview', textContent: preview }),
        favs ? el('span', { className: 'conv-badge', textContent: `★ ${favs}` }) : null,
        entries.length ? el('span', { className: 'conv-count', textContent: String(entries.length) }) : null)));
  row.addEventListener('click', () => go({ name: 'chat', id: conv.id }));
  onLongPress(row, () => openConvMenu(conv));
  return row;
}

function specialRow(icon, label, count, fn) {
  const row = el('button', { type: 'button', className: 'conv special' },
    el('span', { className: 'conv-avatar', textContent: icon }),
    el('span', { className: 'conv-main' }, el('b', { textContent: label })),
    el('span', { className: 'conv-count plain', textContent: String(count) }));
  row.addEventListener('click', fn);
  return row;
}

const matches = (conv) => {
  if (!search) return true;
  const q = search.toLowerCase();
  return conv.title.toLowerCase().includes(q)
    || entriesOf(conv.id).some((e) => e.q.toLowerCase().includes(q) || e.a?.title?.includes(q))
    || messagesOf(conv.id).some((m) => m.text.toLowerCase().includes(q));
};

function renderConvList(which) {
  const list = state.convs
    .filter((c) => (which === 'locked' ? c.locked : !c.locked && (which === 'archive' ? c.archived : !c.archived)))
    .filter(matches)
    .sort((a, b) => lastTs(b) - lastTs(a));

  const box = el('div', { className: 'conv-list' });
  if (which === 'list' && !search) {
    const lockedCount = state.convs.filter((c) => c.locked).length;
    const archivedCount = state.convs.filter((c) => c.archived && !c.locked).length;
    if (lockedCount) {
      box.append(specialRow('🔒', 'שיחות נעולות', lockedCount, async () => {
        if (lockedOpen || await authenticate('פתיחת השיחות הנעולות')) { lockedOpen = true; go({ name: 'locked' }); }
      }));
    }
    if (archivedCount) box.append(specialRow('🗄', 'בארכיון', archivedCount, () => go({ name: 'archive' })));
    const favCount = state.entries.filter((e) => e.fav && !convById(e.conv)?.locked).length;
    if (favCount) box.append(specialRow('★', 'מועדפים', favCount, () => go({ name: 'fav' })));
  }
  for (const c of list) box.append(convRow(c));
  if (!list.length) {
    box.append(el('div', { className: 'empty', textContent: search ? 'לא נמצאו שיחות.'
      : which === 'list' ? 'עדיין אין שיחות. לחצו על ✎ כדי לכתוב מכתב ראשון.'
        : which === 'archive' ? 'הארכיון ריק.' : 'אין שיחות נעולות.' }));
  }
  if (which === 'list') {
    box.append(el('div', { className: 'list-hint', textContent: 'לחיצה ארוכה על שיחה: שינוי שם, שיתוף, ארכיון, נעילה ומחיקה.' }));
    if (!user) {
      const b = el('button', { type: 'button', className: 'link-btn sync-hint', textContent: '👤 התחברות עם Google – לסנכרון בין מכשירים ולשיתוף שיחות' });
      b.addEventListener('click', () => $('account-btn').click());
      box.append(b);
    }
  }
  return box;
}

function renderChat(conv) {
  const box = el('div', { className: 'chat-body' });
  let lastDay = null;
  const items = [...entriesOf(conv.id).map((e) => ({ ts: e.ts, e })), ...messagesOf(conv.id).map((m) => ({ ts: m.ts, m }))]
    .sort((x, y) => x.ts - y.ts);
  if (!items.length) {
    box.append(el('div', { className: 'intro' },
      'כתבו לרבי כפי שכותבים מכתב – מה על הלב, בקשה לברכה או שאלה.', el('br'),
      'בתשובה ייפתח עמוד מאגרות הקודש – עם כל האגרות שבו, תרגום (כשהמענה באידיש) והסבר.'));
  }
  for (const it of items) {
    const k = dayKey(it.ts);
    if (k !== lastDay) { box.append(el('div', { className: 'day-sep', textContent: dayLabel(k) })); lastDay = k; }
    if (it.e) box.append(...entryNodes(it.e, conv)); else box.append(messageBubble(it.m, conv));
  }
  return box;
}

function renderFav() {
  const box = el('div', { className: 'chat-body' });
  const favs = state.entries.filter((e) => e.fav && !convById(e.conv)?.locked).sort((a, b) => b.ts - a.ts);
  if (!favs.length) box.append(el('div', { className: 'empty', textContent: 'עדיין אין מועדפים. לחצו על ☆ בתשובה כדי לשמור אותה.' }));
  for (const e of favs) {
    const from = el('button', { type: 'button', className: 'day-sep link', textContent: `${convById(e.conv)?.title || ''} · ${dayLabel(dayKey(e.ts))}` });
    from.addEventListener('click', () => go({ name: 'chat', id: e.conv }));
    box.append(from, ...entryNodes(e));
  }
  return box;
}

// composer mode in shared conversations: a letter to the Rebbe (owner only) or a message to the others
let toRebbe = true;
function paintComposer(conv) {
  const owner = isOwner(conv);
  const shared = isShared(conv);
  if (!owner) toRebbe = false;
  else if (!shared) toRebbe = true;
  $('mode').hidden = !(owner && shared);
  $('mode').textContent = toRebbe ? '✉️' : '💬';
  $('mode').title = toRebbe ? 'מכתב לרבי (לחצו להודעה למשתתפים)' : 'הודעה למשתתפים (לחצו למכתב לרבי)';
  input.placeholder = toRebbe ? 'כתבו את המכתב…' : 'הודעה למשתתפים…';
}
$('mode').addEventListener('click', () => { toRebbe = !toRebbe; paintComposer(convById(view.id)); input.focus(); });

function render({ scroll = false } = {}) {
  let conv = view.name === 'chat' ? convById(view.id) : null;
  if (view.name === 'chat' && (!conv || (conv.locked && !lockedOpen))) { view = { name: 'list' }; conv = null; }
  if (view.name === 'locked' && !lockedOpen) view = { name: 'list' };
  const inList = ['list', 'archive', 'locked'].includes(view.name);

  const titles = { list: 'מכתבים לרבי', archive: 'בארכיון', locked: '🔒 שיחות נעולות', fav: '★ מועדפים' };
  $('title-text').textContent = conv ? conv.title : titles[view.name];
  $('status').textContent = conv
    ? (isShared(conv) ? `👥 ${conv.members.length} משתתפים · ` : '') + `${entriesOf(conv.id).length} מכתבים`
    : user ? `מחובר: ${user.displayName || user.email}` : 'מענה מתוך אגרות הקודש';
  $('back').hidden = view.name === 'list';
  document.body.dataset.view = view.name;
  $('search-bar').hidden = !inList;
  $('new-chat').hidden = view.name !== 'list';
  form.hidden = !conv;
  if (conv) paintComposer(conv);

  const keepScroll = !scroll && chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80; // stay at the bottom
  const top = chat.scrollTop;
  chat.textContent = '';
  if (inList) chat.append(renderConvList(view.name));
  else if (view.name === 'fav') chat.append(renderFav());
  else chat.append(renderChat(conv));
  if (scroll || (conv && keepScroll)) scrollDown(); else chat.scrollTop = top;
}

$('back').addEventListener('click', () => go({ name: view.name === 'chat' && convById(view.id)?.archived ? 'archive'
  : view.name === 'chat' && convById(view.id)?.locked ? 'locked' : 'list' }));
$('chat-menu').addEventListener('click', () => { const c = convById(view.id); if (c) openConvMenu(c); });
$('title-text').addEventListener('click', () => { const c = view.name === 'chat' && convById(view.id); if (c) openConvMenu(c); });
$('new-chat').addEventListener('click', async () => {
  const conv = { id: newId(), title: 'שיחה חדשה', created: Date.now() };
  state.convs.push(conv);
  save();
  go({ name: 'chat', id: conv.id });
  input.focus();
  if (user) {
    try { await cloud.createConv(conv); Object.assign(conv, { cloud: true, owner: user.uid, members: [user.uid] }); save(); } catch (e) { console.warn(e); }
  }
});
$('search').addEventListener('input', (e) => {
  search = e.target.value.trim();
  chat.textContent = '';
  chat.append(renderConvList(view.name));
});

// ---------- sending ----------
async function sendChat(conv, text) {
  const msg = { id: newId(), conv: conv.id, uid: user.uid, name: user.displayName || user.email, text, ts: Date.now(), replyTo };
  state.messages.push(msg); // shown at once; the snapshot replaces it
  setReply(null);
  render({ scroll: true });
  try {
    await cloud.sendMessage(conv.id, { id: msg.id, text, ts: msg.ts, replyTo: msg.replyTo });
  } catch (e) {
    state.messages = state.messages.filter((m) => m !== msg);
    render();
    alert(`ההודעה לא נשלחה: ${e?.message || e}`);
  }
}

async function submit(text) {
  if (isNativeApp && !API && !askServer()) return;
  const conv = convById(view.id);
  if (!conv) return;
  if (!toRebbe && conv.cloud && user) { await sendChat(conv, text); return; }
  if (!isOwner(conv)) return;
  if (conv.title === 'שיחה חדשה' && !entriesOf(conv.id).length) {
    conv.title = text.split(/\s+/).slice(0, 5).join(' ').slice(0, 40);
    if (conv.cloud) cloud.renameConv(conv.id, conv.title).catch(() => {});
  }
  const entry = { id: newId(), conv: conv.id, q: text, ts: Date.now(), pending: true };
  if (replyTo) { entry.replyTo = replyTo; setReply(null); }
  state.entries.push(entry);
  save();
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
    send.disabled = false;
    save();
    if (view.name === 'chat' && view.id === conv.id) render({ scroll: true }); else render();
    if (conv.cloud && user) cloud.saveEntry(conv.id, entry).catch((e) => console.warn('entry not synced', e));
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || send.disabled) return;
  input.value = ''; input.style.height = '';
  submit(text);
});
const growInput = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
input.addEventListener('input', growInput);
input.addEventListener('focus', () => setTimeout(() => { growInput(); scrollDown(); }, 300)); // after the keyboard opens
if (window.visualViewport) {
  // browsers that do not resize the page for the keyboard: keep the composer above it
  visualViewport.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--vvh', `${visualViewport.height}px`);
    if (document.activeElement === input) scrollDown();
  });
}
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); form.requestSubmit(); }
});
lang.addEventListener('change', () => { try { localStorage.setItem('mlr-lang', lang.value); } catch { /* ignore */ } });

// a join link opened in the browser
pendingJoin = readJoinLink(location.pathname);
if (pendingJoin) history.replaceState(null, '', '/');
// signed in before on this device: connect straight away
let signedInBefore = false;
try { signedInBefore = localStorage.getItem('mlr-signed-in') === '1'; } catch { /* ignore */ }
if (signedInBefore || state.convs.some((c) => c.cloud)) loadCloud().catch((e) => console.warn('cloud', e));
if (pendingJoin) joinNow();

render();
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

  // links to shared conversations open the app
  AppInfo.addListener('appUrlOpen', ({ url }) => { pendingJoin = readJoinLink(url); if (pendingJoin) joinNow(); });

  // Android back button: close what is open before leaving the app
  AppInfo.addListener('backButton', () => {
    if (closeLightbox()) return;
    if (dialog.open) { dialog.close(); return; }
    if ($('conv-menu').open) { closeConvMenu(); return; }
    if ($('account').open) { $('account').close(); return; }
    if (markerMode) { setMarkerMode(false); return; }
    if (view.name !== 'list') { $('back').click(); return; }
    AppInfo.minimizeApp();
  });
  $('chat-menu').before(btn);
  btn.classList.add('list-only');
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
