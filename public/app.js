import { expand as expandAcronym, isAcronym } from './rashei-teivot.js';

const $ = (id) => document.getElementById(id);
const chat = $('chat'), form = $('composer'), input = $('input'), send = $('send');
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

// the language the explanation is written in ('' = the language of the letter); remembered on this device
const LANGS = [['', 'שפת המכתב'], ['he', 'עברית'], ['en', 'English'], ['ru', 'Русский'], ['fr', 'Français'], ['es', 'Español']];
const langName = (code) => LANGS.find(([v]) => v === code)?.[1] || code;
let replyLang = '';
try { replyLang = localStorage.getItem('mlr-lang') || ''; } catch { /* ignore */ }
function setReplyLang(v) { replyLang = v; try { localStorage.setItem('mlr-lang', v); } catch { /* ignore */ } }

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
/** The bubble the selection started in: "select all" (or a drag past its edge) stays inside it. */
let selBubble = null;
const bubbleOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.msg');
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (sel.rangeCount && !sel.isCollapsed) {
    const range = sel.getRangeAt(0);
    const a = bubbleOf(range.startContainer), b = bubbleOf(range.endContainer);
    if (a && a === b) selBubble = a;
    else if (selBubble?.isConnected && range.intersectsNode(selBubble)) {
      const r = document.createRange();
      r.selectNodeContents(selBubble);
      sel.removeAllRanges(); sel.addRange(r);
      return; // the new selection fires this event again
    }
  }
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

// ---------- pages of an answer: the page that opened, and the pages before / after it ----------
// One pager per answer, shared by the bubble (image + text) and the full-screen view, so both
// always show the same page. Going back shows exactly the page you came from; only pages beyond
// those are asked from the server.
const pagers = new Map(); // entry id → pager
const specOf = (imagePath) => (/\/api\/page\/([\w-]+)\.png$/.exec(imagePath || '') || [])[1];
function pagerOf(entry) {
  let p = pagers.get(entry.id);
  if (p) return p;
  const a = entry.a;
  const spec = specOf(a.imagePath);
  const page = { spec, imagePath: a.imagePath, pdfPath: a.pdfPath || (spec ? `/api/page/${spec}.pdf` : null), letters: a.letters || [], title: a.title, volumeHeading: a.volumeHeading };
  p = { pages: [page], at: 0, opened: 0, busy: false, onChange: null };
  pagers.set(entry.id, p);
  return p;
}
const currentPage = (p) => p.pages[p.at];
function whereLabel(p) {
  const offset = p.at - p.opened;
  if (p.busy) return 'טוען…';
  if (offset === 0) return 'העמוד שנפתח';
  if (Math.abs(offset) === 1) return offset > 0 ? 'העמוד הבא' : 'העמוד הקודם';
  return offset > 0 ? `${offset} עמודים קדימה` : `${-offset} עמודים אחורה`;
}
const atFirst = (p) => p.at === 0 && !!p.pages[0].first;
const atLast = (p) => p.at === p.pages.length - 1 && !!p.pages.at(-1).last;
function notifyPager(p) {
  p.onChange?.();
  if (lb.pager === p && !$('lightbox').hidden) paintLightbox();
}
async function turnPager(p, dir) {
  if (p.busy || !p.pages[0].spec) return;
  const edge = dir > 0 ? p.at === p.pages.length - 1 : p.at === 0;
  if (!edge) { p.at += dir; notifyPager(p); return; }
  const from = dir > 0 ? p.pages.at(-1) : p.pages[0];
  if (dir > 0 ? from.last : from.first) return;
  p.busy = true; notifyPager(p);
  try {
    const res = await fetch(`${API}/api/page/${from.spec}/${dir > 0 ? 'next' : 'prev'}`);
    const { page } = res.ok ? await res.json() : {};
    if (page) {
      if (dir > 0) { p.pages.push(page); p.at += 1; } else { p.pages.unshift(page); p.opened += 1; }
    } else if (res.ok) {
      from[dir > 0 ? 'last' : 'first'] = true;
    } else {
      alert('לא ניתן היה לטעון את העמוד. נסו שוב.');
    }
  } catch {
    alert('אין חיבור לשרת.');
  }
  p.busy = false;
  notifyPager(p);
}

// ---------- full-screen image, with pinch zoom ----------
const lb = { pager: null, scale: 1, fitWidth: 0 };
const lbScroll = () => $('lightbox').querySelector('.lightbox-scroll');

function paintLightbox() {
  const p = lb.pager;
  if (!p) return;
  const img = $('lightbox-img');
  const page = currentPage(p);
  const src = API + page.imagePath;
  if (img.getAttribute('src') !== src) { setLightboxScale(1); img.src = src; lbScroll().scrollTo(0, 0); }
  $('lb-where').textContent = whereLabel(p);
  $('lb-prev').disabled = p.busy || atFirst(p);
  $('lb-next').disabled = p.busy || atLast(p);
}

/**
 * Zoom of the full-screen page: 1 = the page fits the screen; more = pinch-zoomed and scrolled by
 * finger. The point under (cx, cy) stays where it is. Wide margins above and below let any part of
 * the page be moved clear of the page-turning controls.
 */
function setLightboxScale(scale, cx, cy) {
  const img = $('lightbox-img'), box = lbScroll();
  const next = Math.min(6, Math.max(1, scale));
  if (next > 1 && !lb.fitWidth) lb.fitWidth = img.clientWidth;
  if (!lb.fitWidth && next > 1) return; // not loaded yet
  const before = img.getBoundingClientRect();
  const px = cx ?? before.left + before.width / 2, py = cy ?? before.top + before.height / 2;
  const fx = before.width ? (px - before.left) / before.width : 0.5, fy = before.height ? (py - before.top) / before.height : 0.5;
  lb.scale = next;
  box.classList.toggle('zoomed', next > 1);
  img.style.width = next > 1 ? `${lb.fitWidth * next}px` : '';
  img.classList.toggle('zoom', next > 1);
  const after = img.getBoundingClientRect();
  box.scrollLeft += after.left + fx * after.width - px;
  box.scrollTop += after.top + fy * after.height - py;
}
$('lightbox-img').addEventListener('load', () => { if (lb.scale === 1) lb.fitWidth = $('lightbox-img').clientWidth; });

function openLightbox(pager, alt) {
  lb.pager = pager; lb.scale = 1; lb.fitWidth = 0;
  hideZoomBar(); hideAcronymPop();
  $('lightbox-img').alt = alt;
  $('lightbox-img').removeAttribute('src');
  $('lightbox-nav').hidden = !pager.pages[0].spec; // older answers have no page link to turn from
  $('lightbox').hidden = false;
  paintLightbox();
  if (!isNativeApp) history.pushState({ lightbox: true }, ''); // browser "back" closes it
}
const turnLightbox = (dir) => lb.pager && turnPager(lb.pager, dir);
$('lb-prev').addEventListener('click', () => turnLightbox(-1));
$('lb-next').addEventListener('click', () => turnLightbox(1));
{ // one finger on the page: to the right = next page (Hebrew book), to the left = previous; two fingers: zoom
  const area = $('lightbox');
  let t = null; let pinch = null;
  const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const mid = (e) => [(e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2];
  area.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { pinch = { d0: dist(e), s0: lb.scale }; t = null; return; }
    t = e.touches.length === 1 && lb.scale === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  area.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [cx, cy] = mid(e);
    setLightboxScale(pinch.s0 * (dist(e) / pinch.d0), cx, cy);
  }, { passive: false });
  area.addEventListener('touchend', (e) => {
    if (pinch) { if (e.touches.length < 2) pinch = null; t = null; return; }
    if (!t || lb.scale !== 1) { t = null; return; } // zoomed: the finger scrolls
    const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y;
    t = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) turnLightbox(dx > 0 ? 1 : -1);
  }, { passive: true });
  area.addEventListener('touchcancel', () => { pinch = null; t = null; }, { passive: true });
  // desktop: ctrl + wheel (or a trackpad pinch) zooms
  lbScroll().addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setLightboxScale(lb.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }, { passive: false });
}
document.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.key === 'ArrowLeft') turnLightbox(1);
  if (e.key === 'ArrowRight') turnLightbox(-1);
});

function closeLightbox(fromHistory = false) {
  if ($('lightbox').hidden) return false;
  $('lightbox').hidden = true;
  setLightboxScale(1);
  $('lightbox-img').removeAttribute('src');
  lb.pager = null;
  if (!isNativeApp && !fromHistory && history.state?.lightbox) history.back();
  return true;
}
window.addEventListener('popstate', () => closeLightbox(true));
$('lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.classList.contains('lightbox-scroll')) closeLightbox(); });
$('lightbox-close-bottom').addEventListener('click', () => closeLightbox());
$('lightbox-img').addEventListener('click', (e) => setLightboxScale(lb.scale > 1 ? 1 : 2.5, e.clientX, e.clientY)); // tap: zoom in / back to fit
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

// ---------- the text of the page: the same page as in the image, previous / next page ----------
/** A markable paragraph that also knows which page it belongs to (for expanding abbreviations). */
function pageParagraph(text, key, spec) {
  const p = markable(text, key);
  if (spec) p.dataset.spec = spec;
  return p;
}

function pageTextSection(entry, pager) {
  const prev = el('button', { type: 'button', className: 'nav-btn', textContent: '→', title: 'העמוד הקודם' });
  const next = el('button', { type: 'button', className: 'nav-btn', textContent: '←', title: 'העמוד הבא' });
  const where = el('span', { className: 'where' });
  const body = el('div', { className: 'letter-body page-text reading' });
  const box = el('details', { className: 'letters', open: !!entry.textOpen },
    el('summary', { textContent: '📜 הטקסט שבעמוד' }),
    el('div', { className: 'pager' }, prev, where, next), // RTL: first = right
    body);
  box.addEventListener('toggle', () => { entry.textOpen = box.open; save(); });

  const fullLetter = (l, spec) => {
    const btn = el('button', { type: 'button', className: 'link-btn', textContent: '📜 האגרת המלאה' });
    const holder = el('div', { className: 'full-letter', hidden: true });
    btn.addEventListener('click', () => {
      holder.hidden = !holder.hidden;
      btn.textContent = holder.hidden ? '📜 האגרת המלאה' : '📜 הסתרת האגרת המלאה';
      if (!holder.hidden && !holder.childNodes.length) holder.append(el('h4', { textContent: `אגרת ${l.number} – הנוסח המלא` }), pageParagraph(l.fullText, `L:${l.id ?? l.number}`, spec));
    });
    return [btn, holder];
  };

  const paint = () => {
    const page = currentPage(pager);
    where.textContent = whereLabel(pager);
    prev.disabled = pager.busy || atFirst(pager);
    next.disabled = pager.busy || atLast(pager);
    body.textContent = '';
    for (const l of page.letters || []) {
      const [fullBtn, fullBox] = l.fullText ? fullLetter(l, page.spec) : [];
      body.append(el('div', { className: 'letter' },
        l.startsOnPage !== false && el('div', { className: 'letter-num', textContent: l.number }),
        pageParagraph(l.pageText, `P:${page.spec}:${l.id ?? l.number}`, page.spec),
        el('div', { className: 'links' },
          l.id != null && el('a', { href: `${API}/api/igrot/${l.id}.pdf`, target: '_blank', rel: 'noopener', textContent: '📄 PDF האגרת' }),
          l.viewerUrl && el('a', { href: l.viewerUrl, target: '_blank', rel: 'noopener', textContent: '🔗 במקור' }),
          fullBtn),
        fullBox));
    }
    if (!page.letters?.length) body.append(el('div', { className: 'note', textContent: 'הטקסט של עמוד זה אינו זמין.' }));
  };
  prev.addEventListener('click', () => turnPager(pager, -1));
  next.addEventListener('click', () => turnPager(pager, 1));

  // swipe: finger to the right = next page (the next page is on the left), to the left = previous
  let touch = null;
  body.addEventListener('touchstart', (e) => {
    touch = e.touches.length === 1 && getSelection().isCollapsed ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (!touch || markerMode) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) turnPager(pager, dx > 0 ? 1 : -1);
  }, { passive: true });

  paint();
  return { box, paint };
}

// ---------- text size of the letter and the analysis – pinch, or the Aa slider; applies to all chats ----------
let textZoom = 100;
try { textZoom = Math.min(200, Math.max(70, Number(localStorage.getItem('mlr-text-zoom')) || 100)); } catch { /* ignore */ }
let zoomTimer = null;
function showZoomBar(sticky = false) {
  $('zoom-bar').hidden = false;
  clearTimeout(zoomTimer);
  if (!sticky) zoomTimer = setTimeout(() => { $('zoom-bar').hidden = true; }, 1800);
}
function hideZoomBar() { clearTimeout(zoomTimer); $('zoom-bar').hidden = true; }
function setTextZoom(pct, { show = true } = {}) {
  textZoom = Math.round(Math.min(200, Math.max(70, pct)));
  document.documentElement.style.setProperty('--rs', String(textZoom / 100));
  $('zoom-range').value = String(textZoom);
  $('zoom-pct').textContent = `${textZoom}%`;
  try { localStorage.setItem('mlr-text-zoom', String(textZoom)); } catch { /* ignore */ }
  if (show) showZoomBar();
}
setTextZoom(textZoom, { show: false });
$('zoom-range').addEventListener('input', (e) => setTextZoom(Number(e.target.value)));
$('zoom-minus').addEventListener('click', () => setTextZoom(textZoom - 10));
$('zoom-plus').addEventListener('click', () => setTextZoom(textZoom + 10));
$('zoom-bar').addEventListener('pointerdown', () => showZoomBar(true));
$('zoom-bar').addEventListener('pointerup', () => showZoomBar());
{ // pinch with two fingers on the letter / analysis text
  let pinch = null;
  const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  chat.addEventListener('touchstart', (e) => {
    pinch = e.touches.length === 2 && e.target.closest?.('.reading') ? { d0: dist(e), z0: textZoom } : null;
  }, { passive: true });
  chat.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    setTextZoom(pinch.z0 * (dist(e) / pinch.d0));
  }, { passive: false });
  for (const ev of ['touchend', 'touchcancel']) chat.addEventListener(ev, () => { pinch = null; }, { passive: true });
}
function textSizeButton() {
  const b = el('button', { type: 'button', className: 'link-btn', textContent: 'Aa', title: 'גודל הטקסט (או צביטה על הטקסט)' });
  b.addEventListener('click', () => showZoomBar(true));
  return b;
}

// ---------- ראשי תיבות: a tap on an abbreviation shows what it stands for ----------
const rtCache = new Map(); // word → options found by the AI, for this page
let rtTimer = null;
function hideAcronymPop(fade = false) {
  const pop = $('rt-pop');
  if (pop.hidden) return;
  clearTimeout(rtTimer);
  if (!fade) { pop.hidden = true; pop.classList.remove('fade'); return; }
  pop.classList.add('fade');
  rtTimer = setTimeout(() => { pop.hidden = true; pop.classList.remove('fade'); }, 400);
}
let rtScrollTop = 0; // where the chat was when the popover opened: real scrolling fades it out
chat.addEventListener('scroll', () => { if (Math.abs(chat.scrollTop - rtScrollTop) > 8) hideAcronymPop(true); }, { passive: true });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#rt-pop')) hideAcronymPop(); }, true);

/** The word under (x, y) inside markable paragraph `p`, with its offsets in the paragraph's text. */
function wordAtPoint(p, x, y) {
  let node; let offset;
  if (document.caretPositionFromPoint) {
    const c = document.caretPositionFromPoint(x, y);
    if (!c) return null;
    node = c.offsetNode; offset = c.offset;
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (!r) return null;
    node = r.startContainer; offset = r.startOffset;
  }
  if (!node || node.nodeType !== 3 || !p.contains(node)) return null;
  const before = document.createRange();
  before.selectNodeContents(p);
  before.setEnd(node, offset);
  const at = before.toString().length;
  const text = p.dataset.text;
  const sep = (ch) => /[\s()[\]{}<>,;:!?.]/.test(ch);
  let s = at, e = at;
  while (s > 0 && !sep(text[s - 1])) s -= 1;
  while (e < text.length && !sep(text[e])) e += 1;
  if (e <= s) return null;
  return { word: text.slice(s, e), start: s, end: e, text };
}

/** DOM range of text offsets [start, end) inside paragraph `p` (whose text nodes may be split by marks). */
function rangeIn(p, start, end) {
  const range = document.createRange();
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let pos = 0; let node; let done = 0;
  while ((node = walker.nextNode())) {
    const len = node.data.length;
    if (!done && start <= pos + len) { range.setStart(node, start - pos); done = 1; }
    if (done === 1 && end <= pos + len) { range.setEnd(node, end - pos); done = 2; break; }
    pos += len;
  }
  if (done < 2) range.setEnd(p, p.childNodes.length);
  return range;
}

/** The run of abbreviations around the tapped word (כ"ק אדמו"ר שליט"א), as [{ word, start, end }]. */
function acronymRun(text, start, end) {
  const words = [];
  const re = /[^\s()[\]{}<>,;:!?.]+/g;
  let m;
  while ((m = re.exec(text))) words.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  const i = words.findIndex((w) => w.start <= start && w.end >= end);
  if (i < 0) return [];
  let a = i, b = i;
  while (a > 0 && isAcronym(words[a - 1].word)) a -= 1;
  while (b < words.length - 1 && isAcronym(words[b + 1].word)) b += 1;
  return words.slice(a, b + 1);
}

function showAcronymPop(p, found) {
  const pop = $('rt-pop');
  const known = expandAcronym(found.word);
  const run = acronymRun(found.text, found.start, found.end).filter((w) => isAcronym(w.word));
  let options = known?.options || [];
  let at = 0;
  pop.textContent = '';
  pop.classList.remove('fade');
  const head = el('div', { className: 'rt-head' });
  const body = el('div', { className: 'rt-body' });
  const foot = el('div', { className: 'rt-foot' });
  const close = el('button', { type: 'button', className: 'rt-x', textContent: '✕', title: 'סגירה' });
  close.addEventListener('click', () => hideAcronymPop());

  const paint = () => {
    head.textContent = '';
    head.append(el('b', { textContent: found.word.replace(/[.,;:!?]+$/, '') }), close);
    body.textContent = '';
    if (!options.length) {
      body.append(el('span', { className: 'rt-none', textContent: 'לא נמצא פענוח במילון.' }));
    } else {
      body.append(el('span', { textContent: options[at] }));
      if (options.length > 1) {
        const prevB = el('button', { type: 'button', className: 'rt-nav', textContent: '›', title: 'האפשרות הקודמת' });
        const nextB = el('button', { type: 'button', className: 'rt-nav', textContent: '‹', title: 'האפשרות הבאה' });
        prevB.disabled = at === 0; nextB.disabled = at === options.length - 1;
        prevB.addEventListener('click', () => { at -= 1; paint(); });
        nextB.addEventListener('click', () => { at += 1; paint(); });
        body.append(el('span', { className: 'rt-pages' }, prevB, el('span', { textContent: `${at + 1}/${options.length}` }), nextB));
      }
    }
    foot.textContent = '';
    if (run.length > 1) {
      const all = el('button', { type: 'button', className: 'rt-btn', textContent: `פתיחת הרצף (${run.length})` });
      all.addEventListener('click', () => {
        body.textContent = '';
        for (const w of run) {
          const ex = expandAcronym(w.word) || rtCache.get(w.word);
          body.append(el('div', { className: 'rt-line' }, el('b', { textContent: w.word }), ` – ${ex?.options?.[0] || ex?.[0] || '?'}`));
        }
        foot.textContent = '';
        foot.append(el('span', { className: 'rt-note', textContent: 'על דרך אפשר' }));
      });
      foot.append(all);
    }
    if (p.dataset.spec) {
      const ai = el('button', { type: 'button', className: 'rt-btn', textContent: options.length ? '🔎 לפי ההקשר' : '🔎 בירור לפי העמוד' });
      ai.addEventListener('click', async () => {
        const words = run.length > 1 ? run.map((w) => w.word) : [found.word];
        ai.disabled = true; ai.textContent = '⏳';
        try {
          const r = await postJson('/api/acronyms', { spec: p.dataset.spec, words: words.map((w) => w.replace(/[.,;:!?]+$/, '')) }, 60000);
          for (const it of r.items || []) rtCache.set(it.word, it.options);
          const mine = r.items?.find((it) => it.word === found.word.replace(/[.,;:!?]+$/, ''))?.options || [];
          options = [...new Set([...mine, ...options])];
          at = 0;
          paint();
        } catch (e) {
          ai.disabled = false; ai.textContent = e.message;
        }
      });
      foot.append(ai);
    }
    foot.append(el('span', { className: 'rt-note', textContent: 'על דרך אפשר' }));
  };
  if (rtCache.has(found.word.replace(/[.,;:!?]+$/, ''))) options = [...new Set([...rtCache.get(found.word.replace(/[.,;:!?]+$/, '')), ...options])];
  paint();
  pop.append(head, body, foot);
  pop.hidden = false;
  rtScrollTop = chat.scrollTop;
  // above the word, inside the screen
  const r = rangeIn(p, found.start, found.end).getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(innerWidth - pr.width - 8, left));
  let top = r.top - pr.height - 8;
  if (top < 8) top = r.bottom + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}
chat.addEventListener('click', (e) => {
  if (markerMode || selecting() || !getSelection().isCollapsed) return;
  const p = e.target.closest?.('.hl');
  if (!p || e.target.closest('mark')) return;
  const found = wordAtPoint(p, e.clientX, e.clientY);
  if (!found || !isAcronym(found.word)) { hideAcronymPop(); return; }
  showAcronymPop(p, found);
});

function markerButton() {
  const b = el('button', { type: 'button', className: 'link-btn', textContent: '🖍 מרקר' });
  b.addEventListener('click', () => {
    setMarkerMode(true);
    alert('מצב מרקר: סמנו טקסט באגרת, בהסבר או בתרגום – הוא יודגש. לסיום לחצו על הכפתור הצהוב למעלה.');
  });
  return b;
}

// ---------- rendering ----------
// ---------- explanation and analysis: only on request, then follow-up questions ----------
async function postJson(path, body, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `אירעה שגיאה (${res.status}). נסו שוב.`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('הניתוח לוקח יותר מדי זמן. נסו שוב.');
    if (e instanceof TypeError) throw new Error('אין חיבור לשרת. נסו שוב.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function syncEntry(entry) {
  const conv = convById(entry.conv);
  save();
  if (conv?.cloud && user && isOwner(conv)) cloud.saveEntry(conv.id, entry).catch((e) => console.warn('not synced', e));
}

/** Translates an analysis that was already written to `language` (the explanation, the page translation, the key quote and the follow-up answers). */
async function translateEntry(entry, language) {
  const a = entry.a;
  if (!a?.explanation || entry.translating) return;
  entry.translating = language;
  render();
  try {
    const r = await postJson('/api/analysis/translate', {
      language, explanation: a.explanation, translation: a.translation || '', keyQuote: a.keyQuote || '', followups: entry.followups || [],
    }, 120000);
    Object.assign(a, { explanation: r.explanation || a.explanation, translation: r.translation, keyQuote: r.keyQuote, analysisLanguage: language });
    (entry.followups || []).forEach((f, i) => { if (r.followups?.[i]) f.a = r.followups[i]; });
    toast(`הניתוח תורגם ל${langName(language)}`);
  } catch (e) {
    alert(`התרגום נכשל: ${e.message}`);
  } finally {
    delete entry.translating;
    syncEntry(entry);
    render();
  }
}

/** The language of the explanation, at the left end of the actions row; changing it translates an existing analysis. */
function langSelect(entry) {
  const a = entry.a;
  const sel = el('select', { className: 'lang-select', title: 'שפת המענה' });
  sel.setAttribute('aria-label', 'שפת המענה');
  for (const [v, label] of LANGS) sel.append(el('option', { value: v, textContent: label }));
  sel.value = a.replyLanguage || replyLang || '';
  sel.addEventListener('change', () => {
    const v = sel.value;
    a.replyLanguage = v || null;
    setReplyLang(v);
    if (a.explanation && v && v !== (a.analysisLanguage || '')) translateEntry(entry, v);
    else syncEntry(entry);
  });
  return el('label', { className: 'lang-wrap', title: 'שפת המענה' }, '🌐', sel);
}

function analysisSection(entry) {
  const a = entry.a;
  const conv = convById(entry.conv);
  const canAsk = isOwner(conv);
  const spec = specOf(a.imagePath);
  const box = el('div', { className: 'analysis reading' });

  if (!a.explanation) {
    if (!canAsk) { box.append(el('div', { className: 'note', textContent: 'עדיין לא נעשה ניתוח לעמוד זה.' })); return box; }
    const btn = el('button', { type: 'button', className: 'analyze-btn', textContent: '✨ הסבר, תרגום וניתוח העמוד' });
    const status = el('div', { className: 'note' });
    if (!spec) { btn.disabled = true; status.textContent = 'לא זמין לתשובות ישנות.'; }
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '⏳ מנתח את העמוד…'; status.textContent = '';
      const wanted = a.replyLanguage || replyLang || undefined;
      try {
        const r = await postJson('/api/analysis', { spec, letter: entry.q, replyLanguage: wanted });
        Object.assign(a, {
          explained: true, explanation: r.explanation, translation: r.translation, keyQuote: r.keyQuote, sourceLanguage: r.sourceLanguage,
          provider: r.provider, analysisLanguage: (r.replyLanguage || wanted || '').slice(0, 2),
        });
        syncEntry(entry);
        entry.showMore = true;
        render();
      } catch (e) {
        btn.disabled = false; btn.textContent = '✨ הסבר, תרגום וניתוח העמוד';
        status.textContent = e.message;
      }
    });
    box.append(btn, status);
    return box;
  }

  if (entry.translating) box.append(el('div', { className: 'note', textContent: `⏳ מתרגם את הניתוח ל${langName(entry.translating)}…` }));

  // the analysis (collapsible), with a button that clears it so a new one can be asked for
  const clear = el('button', { type: 'button', className: 'clear-btn', textContent: '✕', title: 'ניקוי הניתוח ושאלות ההמשך' });
  clear.setAttribute('aria-label', 'ניקוי הניתוח');
  clear.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!confirm('למחוק את ההסבר, התרגום ושאלות ההמשך? אפשר יהיה לבקש ניתוח חדש.')) return;
    for (const k of ['explanation', 'translation', 'keyQuote', 'sourceLanguage', 'analysisLanguage', 'provider']) delete a[k];
    a.explained = false;
    delete entry.followups;
    syncEntry(entry);
    render();
  });
  const sub = el('details', { className: 'sub', open: !entry.analysisClosed },
    el('summary', {}, el('span', { textContent: '✨ כיצד המענה מתייחס למכתב' }), canAsk && clear),
    a.keyQuote && el('div', { className: 'quote', textContent: a.keyQuote }),
    pageParagraph(a.explanation, `E:${entry.id}`, spec),
    a.translation && el('details', { open: true },
      el('summary', { textContent: a.sourceLanguage === 'yiddish' ? 'תרגום מאידיש' : 'תרגום' }),
      pageParagraph(a.translation, `T:${entry.id}`, spec)));
  sub.addEventListener('toggle', () => { entry.analysisClosed = !sub.open; save(); });
  box.append(sub);

  // follow-up questions about the analysis (collapsible)
  const qa = entry.followups || [];
  const thread = el('div', { className: 'followups' },
    ...qa.flatMap((f, i) => [
      el('div', { className: 'fq', textContent: f.q }),
      el('div', { className: 'fa' }, pageParagraph(f.a, `F:${entry.id}:${i}`, spec)),
    ]));
  const fu = el('details', { className: 'sub', open: !entry.followupsClosed },
    el('summary', { textContent: `💬 שאלות המשך${qa.length ? ` (${qa.length})` : ''}` }),
    thread);
  fu.addEventListener('toggle', () => { entry.followupsClosed = !fu.open; save(); });
  if (canAsk && spec) {
    const field = el('textarea', { className: 'fu-input', rows: 1, placeholder: 'שאלת המשך על הניתוח…', maxLength: 2000 });
    const ask = el('button', { type: 'button', className: 'analyze-btn small', textContent: 'שאלה' });
    const status = el('div', { className: 'note' });
    field.addEventListener('input', () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; });
    ask.addEventListener('click', async () => {
      const question = field.value.trim();
      if (!question) return;
      ask.disabled = true; field.disabled = true; status.textContent = '⏳ חושב…';
      try {
        const r = await postJson('/api/analysis/followup', {
          spec, letter: entry.q, analysis: { explanation: a.explanation, translation: a.translation }, history: qa, question,
        });
        entry.followups = [...qa, { q: question, a: r.answer, ts: Date.now() }];
        delete entry.followupsClosed;
        syncEntry(entry);
        render();
      } catch (e) {
        status.textContent = e.message; ask.disabled = false; field.disabled = false;
      }
    });
    fu.append(el('div', { className: 'fu-row' }, field, ask), status);
  } else if (!qa.length) {
    return box; // nothing to show under "follow-up questions"
  }
  box.append(fu);
  return box;
}

function answerBubble(entry) {
  const a = entry.a;
  const pager = pagerOf(entry);
  const img = el('img', { className: 'page-img', alt: `עמוד מאגרות קודש, ${a.volumeHeading}`, loading: 'lazy' });
  img.addEventListener('click', () => openLightbox(pager, img.alt));
  img.addEventListener('error', () => img.replaceWith(el('div', { className: 'note', textContent: 'תמונת העמוד אינה זמינה עוד (נשמרת בשרת לזמן מוגבל). האגרות עצמן שמורות כאן למטה.' })));
  const pdf = el('a', { target: '_blank', rel: 'noopener', textContent: '📄 PDF' });
  const pageWhere = el('div', { className: 'page-where' });
  const text = pageTextSection(entry, pager);
  const paintPage = () => {
    const page = currentPage(pager);
    img.src = API + page.imagePath;
    pdf.href = API + page.pdfPath;
    pageWhere.textContent = pager.at === pager.opened ? '' : `📖 ${whereLabel(pager)}`;
    text.paint();
  };
  pager.onChange = paintPage;
  paintPage();

  const more = el('details', { className: 'more' },
    el('summary', { textContent: a.explanation ? 'הסבר, תרגום והטקסט שבעמוד' : 'פעולות, ניתוח והטקסט שבעמוד' }),
    el('div', { className: 'links' }, pdf, shareButton(entry), textSizeButton(), markerButton(), langSelect(entry)),
    favRow(entry),
    analysisSection(entry),
    text.box,
    el('div', { className: 'note', textContent: 'העמוד מורכב מהטקסט המקוון של אגרות הקודש, ועימודו אינו זהה לעימוד הספר המודפס. ההסבר הוא הצעה להבנה בלבד ואינו פסק הלכה; לשאלות מעשיות – יש להתייעץ עם רב.' }));
  more.open = !!entry.showMore;
  more.addEventListener('toggle', () => { entry.showMore = more.open; save(); });

  return el('div', { className: 'msg them' },
    el('h3', { textContent: `✉️ אגרות קודש · ${a.volumeHeading}${entry.fav ? ' ★' : ''}` }),
    pageWhere,
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
    if (!getSelection().isCollapsed || menuOpen() || selecting() || $('move-dialog').open) { setTimeout(renderSoon, 800); return; }
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
  $('account-in').hidden = !user;
  $('account-out').hidden = !!user;
  if (user) $('account-name').textContent = `${user.displayName || ''} ${user.email ? `(${user.email})` : ''}`.trim();
}
function openAccount() { paintAccount(); $('account').showModal(); }
$('sign-in').addEventListener('click', async () => {
  $('account-status').textContent = 'מתחבר…';
  try {
    await loadCloud();
    if (isNativeApp) {
      // native Google sign-in (Credential Manager), then the same Firebase session in the page
      const Auth = window.Capacitor.registerPlugin('FirebaseAuthentication');
      const result = await Auth.signInWithGoogle();
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
  if (isNativeApp) await window.Capacitor.registerPlugin('FirebaseAuthentication').signOut().catch(() => {});
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
/** Pulling a bubble to the side replies to it (shared conversations), like in WhatsApp. */
function swipeToReply(node, target) {
  let t = null; let dx = 0; let horizontal = false;
  node.addEventListener('touchstart', (e) => {
    const inner = e.target.closest?.('.letter-body, textarea, select, button, a, input');
    t = e.touches.length === 1 && !inner && !selecting() && !markerMode && getSelection().isCollapsed
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    dx = 0; horizontal = false;
  }, { passive: true });
  node.addEventListener('touchmove', (e) => {
    if (!t || e.touches.length !== 1) return;
    dx = e.touches[0].clientX - t.x;
    const dy = e.touches[0].clientY - t.y;
    if (!horizontal) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { t = null; return; } // scrolling
      if (Math.abs(dx) > 14) { horizontal = true; node.classList.add('swiping'); }
    }
    if (!horizontal) return;
    e.preventDefault();
    const d = Math.max(-90, Math.min(90, dx));
    node.style.transform = `translateX(${d}px)`;
    node.classList.toggle('swipe-ready', Math.abs(dx) >= 60);
  }, { passive: false });
  const end = () => {
    if (!t) return;
    const fire = horizontal && Math.abs(dx) >= 60;
    node.style.transform = '';
    node.classList.remove('swiping', 'swipe-ready');
    t = null; horizontal = false;
    if (fire) { setReply(target); if (navigator.vibrate) navigator.vibrate(15); }
  };
  node.addEventListener('touchend', end, { passive: true });
  node.addEventListener('touchcancel', end, { passive: true });
}
const replyQuote = (r) => r && el('div', { className: 'reply-quote' }, el('b', { textContent: r.name }), ` ${r.text}`);
const nameOf = (conv, uid) => conv?.memberInfo?.[uid]?.name || 'משתתף';

// ---------- selection mode: long press on a letter, an answer, a message or a chat (like WhatsApp) ----------
// A letter and its answer are one item: selecting either selects both.
const sel = { items: new Map() }; // 'e:<id>' | 'm:<id>' | 'c:<id>' → { kind, id }
const selecting = () => sel.items.size > 0;
let longPressAt = 0; // a click right after a long press is not a tap
function toggleSelect(kind, id) {
  const k = `${kind}:${id}`;
  if (sel.items.has(k)) sel.items.delete(k); else sel.items.set(k, { kind, id });
  if (navigator.vibrate && sel.items.has(k)) navigator.vibrate(12);
  hideZoomBar(); hideAcronymPop();
  paintSelection();
}
function clearSelection() {
  if (!sel.items.size) return;
  sel.items.clear();
  paintSelection();
}
const selected = (kind) => [...sel.items.values()].filter((i) => i.kind === kind).map((i) => i.id);
function paintSelection() {
  const on = selecting();
  $('sel-bar').hidden = !on;
  document.body.classList.toggle('selecting', on);
  for (const node of chat.querySelectorAll('[data-sel]')) node.classList.toggle('selected', sel.items.has(node.dataset.sel));
  if (!on) return;
  const convs = selected('c').map(convById).filter(Boolean);
  const entries = selected('e');
  const msgs = selected('m');
  $('sel-count').textContent = String(sel.items.size);
  const conv = view.name === 'chat' ? convById(view.id) : null;
  const owner = !!conv && isOwner(conv);
  $('sel-archive').hidden = !convs.length;
  $('sel-lock').hidden = !convs.length;
  $('sel-more').hidden = convs.length !== 1;
  $('sel-copy').hidden = !!convs.length;
  $('sel-move').hidden = !entries.length || !!msgs.length || !owner;
  const canDelete = convs.length ? true
    : owner ? true
      : !entries.length && msgs.every((id) => state.messages.find((m) => m.id === id)?.uid === user?.uid);
  $('sel-delete').hidden = !canDelete;
  if (convs.length) {
    const archived = convs.every((c) => c.archived), locked = convs.every((c) => c.locked);
    $('sel-archive').textContent = archived ? '📤' : '🗄';
    $('sel-archive').title = archived ? 'הוצאה מהארכיון' : 'העברה לארכיון';
    $('sel-lock').textContent = locked ? '🔓' : '🔒';
    $('sel-lock').title = locked ? 'ביטול נעילה' : 'נעילה';
  }
}
/** Marks a bubble as selectable: long press selects it, and while selecting a tap toggles it. */
function selectable(node, kind, id) {
  node.dataset.sel = `${kind}:${id}`;
  node.classList.toggle('selected', sel.items.has(node.dataset.sel));
  onLongPress(node, () => toggleSelect(kind, id));
  return node;
}
chat.addEventListener('click', (e) => {
  if (!selecting()) return;
  const node = e.target.closest('[data-sel]');
  e.preventDefault(); e.stopPropagation();
  if (!node || Date.now() - longPressAt < 400) return;
  const [kind, id] = node.dataset.sel.split(/:(.*)/);
  toggleSelect(kind, id);
}, true);
$('sel-close').addEventListener('click', clearSelection);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selecting()) clearSelection(); });

const entryText = (e) => `${e.q}${e.a ? `\n✉️ ${e.a.title}` : ''}`;
$('sel-copy').addEventListener('click', async () => {
  const ids = new Set([...selected('e'), ...selected('m')]);
  const items = [...state.entries.filter((e) => ids.has(e.id)).map((e) => ({ ts: e.ts, text: entryText(e) })),
    ...state.messages.filter((m) => ids.has(m.id)).map((m) => ({ ts: m.ts, text: `${m.name}: ${m.text}` }))].sort((a, b) => a.ts - b.ts);
  const ok = await copyText(items.map((i) => i.text).join('\n\n'));
  clearSelection();
  toast(ok ? '📋 הועתק' : 'ההעתקה נכשלה');
});
$('sel-delete').addEventListener('click', async () => {
  const convs = selected('c').map(convById).filter(Boolean);
  if (convs.length) { await deleteConvs(convs); return; }
  const entries = selected('e'), msgs = selected('m');
  const n = entries.length + msgs.length;
  const conv = convById(view.id);
  const what = conv?.cloud && isShared(conv) ? ' לכל המשתתפים' : '';
  if (!confirm(n === 1 ? `למחוק${what}?` : `למחוק ${n} פריטים${what}?`)) return;
  const failed = [];
  for (const id of entries) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) continue;
    if (conv?.cloud && user) await cloud.deleteEntry(conv.id, id).catch(() => failed.push(id));
    if (!failed.includes(id)) { state.entries = state.entries.filter((x) => x !== e); pagers.delete(id); }
  }
  for (const id of msgs) {
    if (conv?.cloud && user) await cloud.deleteMessage(conv.id, id).catch(() => failed.push(id));
    if (!failed.includes(id)) state.messages = state.messages.filter((m) => m.id !== id);
  }
  clearSelection(); save(); render();
  if (failed.length) alert('חלק מהפריטים לא נמחקו. נסו שוב.');
});
$('sel-archive').addEventListener('click', () => toggleArchive(selected('c').map(convById).filter(Boolean)));
$('sel-lock').addEventListener('click', () => toggleLock(selected('c').map(convById).filter(Boolean)));
$('sel-more').addEventListener('click', (e) => { const c = convById(selected('c')[0]); if (c) showMenu(e.currentTarget, convMenuItems(c)); });
$('sel-move').addEventListener('click', () => openMoveDialog(selected('e')));

// ---- moving letters (with their answers) to another conversation ----
function openMoveDialog(entryIds) {
  const from = convById(view.id);
  if (!from || !entryIds.length) return;
  const list = $('move-list');
  list.textContent = '';
  const add = (label, fn) => {
    const b = el('button', { type: 'button', textContent: label });
    b.addEventListener('click', async () => { $('move-dialog').close(); await fn(); });
    list.append(b);
  };
  add('＋ שיחה חדשה', () => moveEntries(entryIds, from, null));
  const targets = state.convs.filter((c) => c.id !== from.id && isOwner(c) && (!c.locked || lockedOpen)).sort((a, b) => lastTs(b) - lastTs(a));
  for (const c of targets) add(`${c.locked ? '🔒 ' : c.archived ? '🗄 ' : '✉️ '}${c.title}`, () => moveEntries(entryIds, from, c));
  $('move-dialog').showModal();
}
async function moveEntries(ids, from, target) {
  const entries = ids.map((id) => state.entries.find((e) => e.id === id)).filter(Boolean).sort((a, b) => a.ts - b.ts);
  if (!entries.length) return;
  if (!target) {
    target = { id: newId(), title: entries[0].q.split(/\s+/).slice(0, 5).join(' ').slice(0, 40), created: entries[0].ts };
    state.convs.push(target);
    if (user && cloud) {
      try { await cloud.createConv(target); Object.assign(target, { cloud: true, owner: user.uid, members: [user.uid] }); } catch (e) { console.warn(e); }
    }
  }
  for (const e of entries) {
    const old = e.conv;
    e.conv = target.id;
    delete e.replyTo;
    if (user && cloud) {
      if (target.cloud) cloud.saveEntry(target.id, e).catch((err) => console.warn('not moved to the account', err));
      if (from.cloud) cloud.deleteEntry(old, e.id).catch((err) => console.warn('not removed from the account', err));
    }
  }
  clearSelection(); save(); render();
  toast(`הועבר אל "${target.title}"`);
}

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
  const node = el('div', { className: `msg ${mine ? 'me' : 'them other'}` }, tools,
    !mine && el('div', { className: 'sender', textContent: `✉️ מכתב של ${who}` }),
    el('p', { textContent: entry.q }), time(entry.ts));
  if (isShared(conv)) swipeToReply(node, { kind: 'entry', id: entry.id, name: who, text: entry.q.slice(0, 80) });
  return selectable(node, 'e', entry.id);
}

function messageBubble(m, conv) {
  const mine = user && m.uid === user.uid;
  const node = el('div', { className: `msg chat-msg ${mine ? 'me' : 'them other'}` },
    !mine && el('div', { className: 'sender', textContent: m.name }),
    replyQuote(m.replyTo), el('p', { textContent: m.text }), time(m.ts));
  swipeToReply(node, { kind: 'message', id: m.id, name: mine ? 'אני' : m.name, text: m.text.slice(0, 80) });
  return selectable(node, 'm', m.id);
}

function entryNodes(entry, conv = convById(entry.conv)) {
  const nodes = [questionBubble(entry, conv)];
  if (entry.a && entry.collapsed) {
    const chip = el('button', { type: 'button', className: 'msg them collapsed-a', textContent: `✉️ ${entry.a.title}${entry.fav ? ' ★' : ''} – הרחבה` });
    chip.addEventListener('click', () => { entry.collapsed = false; save(); render(); });
    nodes.push(selectable(chip, 'e', entry.id));
  } else if (entry.a) {
    const bubble = answerBubble(entry);
    if (isShared(conv)) swipeToReply(bubble, { kind: 'answer', id: entry.id, name: 'המענה', text: entry.a.title });
    nodes.push(selectable(bubble, 'e', entry.id));
  } else if (entry.pending) nodes.push(el('div', { className: 'msg them typing', textContent: 'פותחים את אגרות הקודש…' }));
  else nodes.push(selectable(el('div', { className: 'msg them error', textContent: entry.error || 'לא התקבל מענה למכתב זה.' }), 'e', entry.id));
  return nodes;
}

// views: list (all chats) | archive | locked | fav | chat (one conversation)
let view = { name: 'list' };
let search = '';

function go(next) {
  view = next;
  search = '';
  $('search').value = '';
  closeMenu();
  clearSelection();
  hideAcronymPop();
  setReply(null);
  render({ scroll: next.name === 'chat' });
}

const shortTime = (ts) => (dayKey(ts) === dayKey(Date.now())
  ? new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
  : dayKey(ts) === dayKey(Date.now() - 864e5) ? 'אתמול'
    : new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }));

// ---------- the drop-down menu (⋮), like a standard app menu ----------
function showMenu(anchor, items) {
  hideZoomBar(); hideAcronymPop();
  const menu = $('menu');
  menu.textContent = '';
  for (const it of items.filter(Boolean)) {
    if (it.info) { menu.append(el('div', { className: 'menu-info', textContent: it.info })); continue; }
    const b = el('button', { type: 'button', className: `menu-item${it.danger ? ' danger' : ''}`, textContent: it.label });
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { closeMenu(); it.onClick(); });
    menu.append(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, r.left)}px`; // the ⋮ sits at the left edge (RTL)
  menu.hidden = false;
  $('menu-backdrop').hidden = false;
  const mr = menu.getBoundingClientRect(); // keep it on screen
  if (mr.right > innerWidth - 8) menu.style.left = `${Math.max(8, innerWidth - 8 - mr.width)}px`;
  if (mr.bottom > innerHeight - 8) menu.style.top = `${Math.max(8, innerHeight - 8 - mr.height)}px`;
  menu.querySelector('button')?.focus();
}
function closeMenu() { $('menu').hidden = true; $('menu-backdrop').hidden = true; }
const menuOpen = () => !$('menu').hidden;
$('menu-backdrop').addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen()) closeMenu(); });
let nativeSettings = null; // set in the Android app: opens the settings & updates dialog

// ---- conversation actions (the ⋮ of a chat, or a selected chat in the list) ----
function convMenuItems(conv) {
  const owner = isOwner(conv);
  const people = isShared(conv) ? (conv.members || []).map((u) => nameOf(conv, u) + (u === conv.owner ? ' (פותח השיחה)' : '')).join(', ') : '';
  return [
    people && { info: `👥 ${people}` },
    owner && { label: '✎ שינוי שם', onClick: () => renameConv(conv) },
    owner && { label: '👥 שיתוף עם אנשי קשר', onClick: () => shareConv(conv) },
    owner && { label: '🔗 העתקת קישור לשיחה', onClick: () => copyConvLink(conv) },
    owner && (isShared(conv) || conv.inviteToken) && { label: '✋ הפסקת השיתוף', onClick: () => stopSharingConv(conv) },
    { label: conv.archived ? '📤 הוצאה מהארכיון' : '🗄 העברה לארכיון', onClick: () => toggleArchive([conv]) },
    { label: conv.locked ? '🔓 ביטול נעילה' : '🔒 נעילת השיחה (במכשיר זה)', onClick: () => toggleLock([conv]) },
    { label: !conv.cloud ? '🗑 מחיקת השיחה' : owner ? '🗑 מחיקת השיחה לכולם' : '🚪 יציאה מהשיחה', danger: true, onClick: () => deleteConvs([conv]) },
  ];
}
function homeMenuItems() {
  return [
    { label: user ? `👤 ${user.displayName || user.email}` : '👤 התחברות עם Google', onClick: openAccount },
    { label: 'Aa גודל הטקסט', onClick: () => showZoomBar(true) },
    nativeSettings && { label: '⚙ הגדרות ועדכונים', onClick: nativeSettings },
  ];
}

async function renameConv(conv) {
  const t = prompt('שם השיחה:', conv.title);
  if (!t || !t.trim()) return;
  conv.title = t.trim().slice(0, 50); save(); render();
  if (conv.cloud) await cloud.renameConv(conv.id, conv.title).catch(() => alert('שינוי השם לא נשמר בחשבון.'));
}
function toggleArchive(convs) {
  const archive = !convs.every((c) => c.archived);
  for (const c of convs) c.archived = archive;
  clearSelection(); save();
  if (view.name === 'chat') go({ name: 'list' }); else render();
  toast(archive ? (convs.length === 1 ? '🗄 הועבר לארכיון' : `🗄 ${convs.length} שיחות הועברו לארכיון`) : '📤 הוצא מהארכיון');
}
async function toggleLock(convs) {
  const lock = !convs.every((c) => c.locked);
  clearSelection();
  if (lock) {
    if (!(await canAuthenticate())) {
      alert('במכשיר זה לא הוגדרו טביעת אצבע או נעילת מסך, ולכן אי אפשר לנעול שיחות.');
      return;
    }
    for (const c of convs) c.locked = true;
    save();
    alert(convs.length === 1 ? 'השיחה ננעלה. היא מופיעה עכשיו רק תחת "שיחות נעולות", שנפתחות בטביעת אצבע או בקוד המכשיר.'
      : 'השיחות ננעלו. הן מופיעות עכשיו רק תחת "שיחות נעולות", שנפתחות בטביעת אצבע או בקוד המכשיר.');
    if (view.name === 'chat') go({ name: 'list' }); else render();
  } else if (lockedOpen || await authenticate('ביטול נעילת השיחה')) {
    for (const c of convs) delete c.locked;
    save(); render();
  }
}
/** The invite link of a conversation (creates it if needed), or null if the user must sign in first. */
async function conversationLink(conv) {
  await loadCloud();
  if (!user) {
    $('account-status').textContent = 'כדי לשתף שיחה יש להתחבר עם חשבון Google.';
    paintAccount(); $('account').showModal();
    return null;
  }
  if (!conv.cloud) throw new Error('השיחה עדיין מסתנכרנת לחשבון. נסו שוב בעוד רגע.');
  conv.inviteToken = await cloud.inviteToken(conv);
  return `${SITE}/join/${conv.id}.${conv.inviteToken}`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* older WebViews */ }
  const area = el('textarea', { value: text });
  area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area); area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

async function copyConvLink(conv) {
  clearSelection();
  try {
    const link = await conversationLink(conv);
    if (!link) return;
    if (await copyText(link)) toast('🔗 הקישור לשיחה הועתק'); else prompt('העתיקו את הקישור:', link);
  } catch (e) { alert(e.message); }
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function shareConv(conv) {
  clearSelection();
  try {
    const link = await conversationLink(conv);
    if (!link) return;
    const text = `הצטרפו לשיחה "${conv.title}" ב"מכתבים לרבי" – תוכלו לראות את המכתבים והמענים ולהגיב:\n${link}`;
    if (isNativeApp) await window.Capacitor.registerPlugin('Share').share({ title: 'מכתבים לרבי', text, dialogTitle: 'שיתוף השיחה' });
    else if (navigator.share) await navigator.share({ title: 'מכתבים לרבי', text });
    else { await navigator.clipboard.writeText(text).catch(() => {}); alert(`הקישור הועתק:\n${link}`); }
  } catch (e) {
    if (!/cancel|abort/i.test(`${e?.name} ${e?.message}`)) alert(`השיתוף נכשל: ${e?.message || e}`);
  }
}
async function stopSharingConv(conv) {
  clearSelection();
  if (!confirm('להפסיק את השיתוף? המשתתפים האחרים יוסרו מהשיחה והקישור יבוטל.')) return;
  await cloud.stopSharing(conv).catch(() => alert('הפעולה נכשלה.'));
}
async function deleteConvs(convs) {
  const one = convs.length === 1 ? convs[0] : null;
  const owner = (c) => isOwner(c);
  const question = one
    ? (!one.cloud ? `למחוק את השיחה "${one.title}" מהמכשיר?`
      : owner(one) ? `למחוק את השיחה "${one.title}"? היא תימחק לכל המשתתפים ומכל המכשירים.` : `לצאת מהשיחה "${one.title}"?`)
    : `למחוק ${convs.length} שיחות? שיחות שנשמרו בחשבון יימחקו לכל המשתתפים.`;
  if (!confirm(question)) return;
  for (const conv of convs) {
    try {
      if (conv.cloud) await (owner(conv) ? cloud.deleteConv(conv.id) : cloud.leaveConv(conv.id));
    } catch (e) { alert(`הפעולה נכשלה: ${e?.message || e}`); return; }
    dropConv(conv.id);
  }
  clearSelection(); save();
  if (view.name === 'chat') go({ name: 'list' }); else render();
}

/** Long press (touch) or right click (mouse). A press on selectable text is left to the text selection. */
function onLongPress(node, fn) {
  let timer = null;
  let fired = false;
  const fire = () => {
    if (Date.now() - longPressAt < 400) return; // the same press, reported twice (timer + contextmenu)
    longPressAt = Date.now();
    fired = true;
    fn();
  };
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); fire(); });
  node.addEventListener('touchstart', (e) => {
    fired = false;
    clearTimeout(timer);
    if (e.touches.length !== 1 || e.target.closest?.('.hl, textarea, input, select')) return;
    timer = setTimeout(fire, 500);
  }, { passive: true });
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
  return selectable(row, 'c', conv.id);
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
    box.append(el('div', { className: 'list-hint', textContent: 'לחיצה ארוכה על שיחה בוחרת אותה: ארכיון, נעילה, מחיקה ועוד.' }));
    if (!user) {
      const b = el('button', { type: 'button', className: 'link-btn sync-hint', textContent: '👤 התחברות עם Google – לסנכרון בין מכשירים ולשיתוף שיחות' });
      b.addEventListener('click', openAccount);
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
  if (selecting()) { // a selection belongs to the view it was made in
    const kinds = new Set([...sel.items.values()].map((i) => i.kind));
    if ((conv && kinds.has('c')) || (!conv && !kinds.has('c'))) sel.items.clear();
  }
  hideAcronymPop();
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
  paintSelection();
}

$('back').addEventListener('click', () => go({ name: view.name === 'chat' && convById(view.id)?.archived ? 'archive'
  : view.name === 'chat' && convById(view.id)?.locked ? 'locked' : 'list' }));
$('chat-menu').addEventListener('click', (e) => { const c = convById(view.id); if (c) showMenu(e.currentTarget, convMenuItems(c)); });
$('home-menu').addEventListener('click', (e) => showMenu(e.currentTarget, homeMenuItems()));
$('title-text').addEventListener('click', () => { const c = view.name === 'chat' && convById(view.id); if (c) showMenu($('chat-menu'), convMenuItems(c)); });
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
      body: JSON.stringify({ letter: text, replyLanguage: replyLang || undefined }),
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

  nativeSettings = () => { $('server-input').value = API; dialog.showModal(); };
  // the server address is built into the app; the field is only shown if it is missing
  $('server-section').hidden = !!window.MLR_API_BASE;

  // links to shared conversations open the app
  AppInfo.addListener('appUrlOpen', ({ url }) => { pendingJoin = readJoinLink(url); if (pendingJoin) joinNow(); });

  // Android back button: close what is open before leaving the app
  AppInfo.addListener('backButton', () => {
    if (closeLightbox()) return;
    if (dialog.open) { dialog.close(); return; }
    if (menuOpen()) { closeMenu(); return; }
    if ($('move-dialog').open) { $('move-dialog').close(); return; }
    if (selecting()) { clearSelection(); return; }
    if (!$('rt-pop').hidden) { hideAcronymPop(); return; }
    if ($('account').open) { $('account').close(); return; }
    if (markerMode) { setMarkerMode(false); return; }
    if (view.name !== 'list') { $('back').click(); return; }
    AppInfo.minimizeApp();
  });
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
