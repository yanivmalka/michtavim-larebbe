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

// ---------- short sounds: recording started / ended, an answer arrived ----------
let actx = null;
function tone(freqs, dur = 0.1, gap = 0.11, vol = 0.14) {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    freqs.forEach((f, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      const t = actx.currentTime + i * gap;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.03);
    });
  } catch { /* no sound on this device */ }
}
const SOUND = {
  recStart: () => tone([880]),
  recStop: () => tone([587]),
  recCancel: () => tone([330], 0.14),
  answer: () => tone([784, 1047, 1319], 0.22, 0.13, 0.16),
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
    if (s?.convs) {
      s.entries = (s.entries || []).filter((e) => !e.preparing); // a photo that was still loading when the app closed
      for (const e of s.entries) if (e.qLocked) delete e.qOpen;
      return { marks: {}, abbr: {}, ...s };
    }
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

/**
 * A paragraph whose text can be marked; marks are stored under `key`. `ai` holds ranges the
 * explanation rests on (marked by the AI): shown like the user's marks, but not removable.
 */
function markable(text, key, ai = []) {
  const p = el('p', { className: 'hl' });
  p.dataset.key = key;
  p.dataset.text = text;
  p.aiRanges = ai;
  paintMarks(p);
  return p;
}

function paintMarks(p) {
  const text = p.dataset.text;
  const mine = state.marks[p.dataset.key] || [];
  const ai = p.aiRanges || [];
  p.textContent = '';
  const cuts = new Set([0, text.length]);
  for (const [s, e] of [...mine, ...ai]) { cuts.add(Math.max(0, Math.min(text.length, s))); cuts.add(Math.max(0, Math.min(text.length, e))); }
  const pts = [...cuts].sort((a, b) => a - b);
  for (let k = 0; k + 1 < pts.length; k++) {
    const s = pts[k], e = pts[k + 1];
    const i = mine.findIndex(([a, b]) => a <= s && b >= e);
    const fromAi = ai.some(([a, b]) => a <= s && b >= e);
    if (i < 0 && !fromAi) { p.append(text.slice(s, e)); continue; }
    const m = el('mark', { textContent: text.slice(s, e), className: fromAi ? (i < 0 ? 'ai' : 'ai mine') : '' });
    if (i >= 0) {
      m.title = 'לחיצה מסירה את ההדגשה';
      m.addEventListener('click', () => {
        if (!getSelection().isCollapsed) return;
        state.marks[p.dataset.key].splice(i, 1);
        if (!state.marks[p.dataset.key].length) delete state.marks[p.dataset.key];
        markChanged(p.dataset.key);
        paintMarks(p);
      });
    } else m.title = 'קטע שעליו מושתת ההסבר';
    p.append(m);
  }
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
  markChanged(p.dataset.key);
  getSelection().removeAllRanges();
  paintMarks(p);
  paintTools(null, null);
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
  paintTools(selectedRange(), toolEntry);
}

// ---------- tools, while text of an answer is selected: highlight, text size, PDF, share, marker ----------
let toolEntry = null; // the answer whose text is selected
function paintTools(found, entry) {
  toolEntry = entry;
  const page = entry && currentPage(pagerOf(entry));
  $('hl-add').hidden = !found;
  $('tool-aramaic').hidden = !found;
  $('tool-size').hidden = !entry;
  $('tool-share').hidden = !entry;
  $('tool-pdf').hidden = !page?.pdfPath;
  if (page?.pdfPath) $('tool-pdf').href = API + page.pdfPath;
  $('hl-bar').hidden = !found && !entry && !markerMode;
}
/** The answer (entry with an answer) whose bubble holds the current selection, if any. */
function selectedEntry() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const bubble = bubbleOf(sel.getRangeAt(0).commonAncestorContainer);
  const key = bubble?.dataset.sel || '';
  const entry = key.startsWith('e:') ? state.entries.find((e) => e.id === key.slice(2)) : null;
  return entry?.a ? entry : null;
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
  paintTools(found, selectedEntry());
  clearTimeout(markTimer);
  if (markerMode && found) markTimer = setTimeout(() => { const f = selectedRange(); if (f) applyMark(f); }, 900);
});
for (const id of ['hl-add', 'hl-mode', 'tool-size', 'tool-pdf', 'tool-share', 'tool-aramaic']) $(id).addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
$('hl-add').addEventListener('click', () => { const f = selectedRange() || lastRange; if (f) applyMark(f); lastRange = null; });
$('hl-mode').addEventListener('click', () => {
  const on = !markerMode;
  setMarkerMode(on);
  if (on) toast('מצב מרקר: כל טקסט שתסמנו באגרת, בהסבר או בתרגום יודגש. לסיום – הכפתור הצהוב למעלה.');
});
$('tool-size').addEventListener('click', () => showZoomBar(true));
$('tool-share').addEventListener('click', async () => {
  const entry = toolEntry;
  if (!entry) return;
  try { await shareAnswer(entry); } catch (e) { if (e?.name !== 'AbortError' && !/cancel/i.test(e?.message || '')) alert(`השיתוף נכשל: ${e?.message || e}`); }
});

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

// the passages the explanation rests on: { spec, id, r: [start, end, …] } per letter, marked on the image and in the text
const pairsOf = (flat) => { const out = []; for (let i = 0; i + 1 < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
const aiRangesOf = (entry, spec, id) => (entry?.a?.highlights || []).filter((h) => h.spec === spec && h.id === id).flatMap((h) => pairsOf(h.r));
function hlParam(entry, spec) {
  const hs = (entry?.a?.highlights || []).filter((h) => h.spec === spec && h.r?.length);
  return hs.map((h) => `${h.id}:${pairsOf(h.r).map(([s, e]) => `${s}-${e}`).join(',')}`).join(';');
}
/** The image of a page; when it is the page the explanation was made on, its passages are marked. */
function pageImageUrl(entry, page) {
  const hl = entry ? hlParam(entry, page.spec) : '';
  return `${API}${page.imagePath}${hl ? `?hl=${encodeURIComponent(hl)}` : ''}`;
}
/** When another page is shown than the one with the explanation's marks: says where they are. */
function hlNote(entry, pager) {
  const hs = entry?.a?.highlights || [];
  if (!hs.length || hs.some((h) => h.spec === currentPage(pager).spec)) return '';
  const at = pager.pages.findIndex((p) => hs.some((h) => h.spec === p.spec));
  const where = at < 0 ? 'בעמוד אחר' : at === pager.opened ? 'בעמוד שנפתח' : at < pager.at ? 'בעמוד קודם' : 'בעמוד הבא';
  return `🖍 הסימונים של ההסבר ${where}`;
}
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
/** Only the arrows and "where" labels changed (a page was added at an end): no redraw of the text. */
function notifyNav(p) {
  p.onNav?.();
  if (lb.pager === p && !$('lightbox').hidden) paintLightbox();
}

/**
 * Loads the page before (dir -1) or after (dir 1) the pages already known, without moving the view.
 * One request per direction at a time; a turn waits for a request already on the way.
 */
function loadNeighbor(p, dir) {
  const key = dir > 0 ? 'next' : 'prev';
  p.inflight ||= {};
  if (p.inflight[key]) return p.inflight[key];
  const from = dir > 0 ? p.pages.at(-1) : p.pages[0];
  if (!from.spec || (dir > 0 ? from.last : from.first)) return Promise.resolve(false);
  p.inflight[key] = (async () => {
    try {
      const res = await fetch(`${API}/api/page/${from.spec}/${key}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { page } = await res.json();
      if (!page) { from[dir > 0 ? 'last' : 'first'] = true; return false; }
      if (dir > 0) p.pages.push(page);
      else { p.pages.unshift(page); p.at += 1; p.opened += 1; }
      new Image().src = API + page.imagePath; // the browser fetches (and the server draws) the image now
      return true;
    } finally {
      p.inflight[key] = null;
    }
  })();
  return p.inflight[key];
}
/** Gets the pages next to the one shown, so turning to them is instant. */
function prefetchAround(p) {
  if (!p.pages[0].spec) return;
  for (const dir of [1, -1]) {
    const edge = dir > 0 ? p.at === p.pages.length - 1 : p.at === 0;
    if (edge) loadNeighbor(p, dir).then((added) => { if (added) notifyNav(p); }).catch(() => {});
  }
}
async function turnPager(p, dir) {
  if (p.busy || !p.pages[0].spec) return;
  const edge = dir > 0 ? p.at === p.pages.length - 1 : p.at === 0;
  if (edge) {
    const from = dir > 0 ? p.pages.at(-1) : p.pages[0];
    if (dir > 0 ? from.last : from.first) return;
    p.busy = true; notifyNav(p);
    let added = false;
    try {
      added = await loadNeighbor(p, dir);
    } catch (e) {
      alert(e instanceof TypeError ? 'אין חיבור לשרת.' : 'לא ניתן היה לטעון את העמוד. נסו שוב.');
    }
    p.busy = false;
    if (!added) { notifyNav(p); return; }
  }
  p.at += dir;
  notifyPager(p);
  prefetchAround(p);
}

// ---------- full-screen image, with pinch zoom ----------
const lb = { pager: null, entry: null, scale: 1, fitWidth: 0 };
const lbScroll = () => $('lightbox').querySelector('.lightbox-scroll');

function paintLightbox() {
  const p = lb.pager;
  if (!p) return;
  const img = $('lightbox-img');
  const page = currentPage(p);
  const src = pageImageUrl(lb.entry, page);
  if (img.getAttribute('src') !== src) { setLightboxScale(1); img.src = src; lbScroll().scrollTo(0, 0); }
  const note = hlNote(lb.entry, p);
  $('lb-where').textContent = note ? `${whereLabel(p)} · ${note}` : whereLabel(p);
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

function openLightbox(pager, alt, entry = null) {
  if (entry && isUnread(entry)) { setRead(entry); save(); }
  prefetchAround(pager);
  lb.pager = pager; lb.entry = entry; lb.scale = 1; lb.fitWidth = 0;
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
  lb.pager = null; lb.entry = null;
  if (!isNativeApp && !fromHistory && history.state?.lightbox) history.back();
  return true;
}
window.addEventListener('popstate', () => closeLightbox(true));
// a tap on the left third turns to the next page, on the right third to the previous one (a Hebrew book);
// a tap in the middle zooms in on the page (and back to fit), or closes when beside the page
$('lightbox').addEventListener('click', (e) => {
  if (e.target !== e.currentTarget && !e.target.classList.contains('lightbox-scroll') && e.target !== $('lightbox-img')) return;
  if (lb.scale > 1) { setLightboxScale(1); return; }
  const f = e.clientX / innerWidth;
  if (f < 0.3 && !$('lightbox-nav').hidden) { turnLightbox(1); return; }
  if (f > 0.7 && !$('lightbox-nav').hidden) { turnLightbox(-1); return; }
  if (e.target === $('lightbox-img')) setLightboxScale(2.5, e.clientX, e.clientY); else closeLightbox();
});
$('lightbox-close-bottom').addEventListener('click', () => closeLightbox());
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
  const marked = pageImageUrl(entry, { spec: specOf(a.imagePath), imagePath: a.imagePath });
  const imageUrl = API ? marked : new URL(marked, location.href).href;
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

// ---------- favourites: the star in the answer's row opens the tags under it ----------
/** The star button; a tap opens or closes the tags panel (it never removes the chosen tags). */
function favStar(entry, onToggle) {
  const star = el('button', { type: 'button', className: `star${entry.fav ? ' on' : ''}`, textContent: entry.fav ? '★' : '☆' });
  star.title = entry.tagsOpen ? 'הסתרת התגיות' : entry.fav ? 'התגיות שנבחרו' : 'שמירה במועדפים';
  star.setAttribute('aria-label', star.title);
  star.setAttribute('aria-expanded', String(!!entry.tagsOpen));
  star.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); // inside a <summary>: do not open / close the details
    if (!entry.fav) { entry.fav = { tags: [] }; favChanged(entry); }
    entry.tagsOpen = !entry.tagsOpen;
    save();
    onToggle();
  });
  return star;
}

/** Under the answer's row: the tags (scrollable, chosen first) when open, or a line of the chosen tags when closed. */
function favPanel(entry) {
  const box = el('div', { className: 'fav-panel' });
  let order = null; // the order is fixed while the panel is open, so chips do not jump under the finger
  const paint = () => {
    box.textContent = '';
    if (!entry.fav) { order = null; return; }
    if (!entry.tagsOpen) {
      order = null;
      if (entry.fav.tags.length) {
        const line = el('button', { type: 'button', className: 'fav-line', textContent: `★ ${entry.fav.tags.join(' · ')}` });
        line.addEventListener('click', () => { entry.tagsOpen = true; save(); render(); });
        box.append(line);
      }
      return;
    }
    const chosen = entry.fav.tags;
    order ||= [...chosen, ...TAGS.filter((t) => !chosen.includes(t))];
    for (const t of chosen) if (!order.includes(t)) order.push(t);
    const row = el('div', { className: 'chip-row' });
    for (const tag of order) {
      const on = chosen.includes(tag);
      const chip = el('button', { type: 'button', className: `chip${on ? ' on' : ''}`, textContent: tag });
      chip.setAttribute('aria-pressed', String(on));
      chip.addEventListener('click', () => {
        entry.fav.tags = on ? chosen.filter((t) => t !== tag) : [...chosen, tag];
        favChanged(entry); paint();
      });
      row.append(chip);
    }
    const add = el('button', { type: 'button', className: 'chip', textContent: '+ תיאור משלך' });
    add.addEventListener('click', () => {
      const tag = (prompt('תיאור משלך:') || '').trim().slice(0, 20);
      if (tag && !entry.fav.tags.includes(tag)) { entry.fav.tags.push(tag); favChanged(entry); paint(); }
    });
    const remove = el('button', { type: 'button', className: 'chip remove', textContent: '☆ הסרה מהמועדפים' });
    remove.addEventListener('click', () => {
      if (entry.fav.tags.length && !confirm('להסיר מהמועדפים? התגיות שנבחרו יימחקו.')) return;
      delete entry.fav; delete entry.tagsOpen;
      favChanged(entry); render();
    });
    row.append(add, remove);
    box.append(row);
  };
  paint();
  return box;
}

// ---------- the text of the page: the same page as in the image, previous / next page ----------
/** A markable paragraph that also knows which page it belongs to (for expanding abbreviations). */
function pageParagraph(text, key, spec, ai = []) {
  const p = markable(text, key, ai);
  if (spec) p.dataset.spec = spec;
  return p;
}

function pageTextSection(entry, pager) {
  const prev = el('button', { type: 'button', className: 'nav-btn', textContent: '→', title: 'העמוד הקודם' });
  const next = el('button', { type: 'button', className: 'nav-btn', textContent: '←', title: 'העמוד הבא' });
  const where = el('span', { className: 'where' });
  const body = el('div', { className: 'letter-body page-text reading' });
  const box = el('details', { className: 'letters fold', open: !!entry.textOpen },
    el('summary', {}, el('span', { className: 'sum-label', textContent: '📜 הטקסט שבעמוד' })),
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

  const nav = () => {
    where.textContent = whereLabel(pager);
    prev.disabled = pager.busy || atFirst(pager);
    next.disabled = pager.busy || atLast(pager);
  };
  const paint = () => {
    const page = currentPage(pager);
    nav();
    body.textContent = '';
    for (const l of page.letters || []) {
      const [fullBtn, fullBox] = l.fullText ? fullLetter(l, page.spec) : [];
      body.append(el('div', { className: 'letter' },
        l.startsOnPage !== false && el('div', { className: 'letter-num', textContent: l.number }),
        pageParagraph(l.pageText, `P:${page.spec}:${l.id ?? l.number}`, page.spec, aiRangesOf(entry, page.spec, l.id)),
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
  return { box, paint, nav };
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

/** The sentence around [start, end) in `text` – what the AI gets when asked to explain an abbreviation in context. */
function sentenceAround(text, start, end) {
  const stop = /[.!?:\n]/;
  let s = start, e = end;
  while (s > 0 && !stop.test(text[s - 1]) && start - s < 400) s -= 1;
  while (e < text.length && !stop.test(text[e]) && e - end < 400) e += 1;
  if (e < text.length && stop.test(text[e]) && text[e] !== '\n') e += 1; // keep the sentence's end mark
  return text.slice(s, e).trim();
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

/** Puts the popover above the word, inside the screen. */
function placePop(p, found) {
  const pop = $('rt-pop');
  const r = rangeIn(p, found.start, found.end).getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(innerWidth - pr.width - 8, left));
  let top = r.top - pr.height - 8;
  if (top < 8) top = r.bottom + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

// ---- Aramaic (quotes from the Zohar, the Gemara…): a tap shows the phrase translated, and word by word ----
const ARAMAIC_WORDS = new Set(`דא הא האי הני הנך מאי מאן כד היכי הכי אמאי אטו דהא איהו איהי אינון אנן לית אית ליה להו בהו ביה מיניה דיליה קמי קמיה קא קאמר
תנא תניא חזי נמי סגי טפי עלמא עלמין מלכא קדישא רחמנא אורייתא שכינתא עילאה תתאה זעירא יומא ליליא ארעא שמיא נהורא חשוכא סטרא אחרא כולא כולהו חדא תרי תרין תלת
בריך דכתיב כתיב אתמר איתמר אזיל הוה הוו להוי מילתא פתגמא גברא נשמתא רוחא נפשא גופא ליבא עובדא דרגא רזא רזין עתיקא אנפין אתר פום אורחא קושטא
שלמא רעוא רעותא דחילו רחימו חדוה חדוותא אתערותא דלעילא דלתתא לעילא לתתא מלגאו מלבר גו בגו כגוונא אלין אילין עביד אתא נפק נפיק
יתיב קאי קיימא שריא סליק נחית אשתכח איתא איכא ליכא ידעינן שמעינן אמינא בעי בעא תיובתא קשיא מסתברא איפכא לאו ברא ברתא אבוה אחוי`.split(/\s+/));
const NOT_ARAMAIC = new Set('דוגמא דא"ח קופסא כורסא מלתא'.split(' '));
const bareWord = (w) => w.normalize('NFC').replace(/[\u0591-\u05c7]/g, '').replace(/^["'(\[]+|["').,;:!?\]]+$/g, '');
function looksAramaic(word) {
  const w = bareWord(word);
  if (!/^[א-ת]{2,}$/.test(w) || NOT_ARAMAIC.has(w)) return false;
  const core = w.replace(/^[ודבלכ]{1,2}(?=[א-ת]{3,})/, '');
  return ARAMAIC_WORDS.has(w) || ARAMAIC_WORDS.has(core) || /^ד[א-ת]{2,}א$/.test(w) || (w.length >= 4 && /תא$/.test(w)) || (w.length >= 5 && /(נא|יהו|ייהו)$/.test(w));
}
const aramaicCache = new Map(); // sentence | word | language → the translation
function showAramaicPop(p, found, phrase = found.word) {
  const pop = $('rt-pop');
  const lang = replyLang || 'he';
  const sentence = sentenceAround(found.text, found.start, found.end);
  const key = `${sentence}|${phrase}|${lang}`;
  let wordsOpen = false;
  pop.textContent = '';
  pop.classList.remove('fade');
  const close = el('button', { type: 'button', className: 'rt-x', textContent: '✕', title: 'סגירה' });
  close.addEventListener('click', () => hideAcronymPop());
  const head = el('div', { className: 'rt-head' });
  const body = el('div', { className: 'rt-body' });
  const foot = el('div', { className: 'rt-foot' });
  const paint = () => {
    const r = aramaicCache.get(key);
    head.replaceChildren(el('b', { textContent: r?.phrase || bareWord(phrase) }), el('span', { className: 'rt-count', textContent: 'ארמית' }), close);
    body.textContent = ''; foot.textContent = '';
    if (!r) body.append(el('div', { className: 'wait-line' }, el('span', { className: 'spinner' }), 'מתרגמים מארמית…'));
    else if (r.error) body.append(el('span', { className: 'rt-none', textContent: r.error }));
    else if (!r.isAramaic) body.append(el('span', { className: 'rt-none', textContent: 'לא זוהתה כאן ארמית.' }));
    else {
      body.append(el('div', { className: 'rt-text', textContent: r.translation }));
      if (wordsOpen) for (const w of r.words) body.append(el('div', { className: 'rt-line' }, el('b', { textContent: w.word }), ` – ${w.meaning}`));
      if (r.words.length) {
        const b = el('button', { type: 'button', className: 'rt-btn', textContent: wordsOpen ? 'הסתרת פירוש המילים' : 'פירוש כל מילה' });
        b.addEventListener('click', () => { wordsOpen = !wordsOpen; paint(); placePop(p, found); });
        foot.append(b);
      }
    }
    foot.append(el('span', { className: 'rt-note', textContent: 'על דרך אפשר' }));
  };
  paint();
  pop.append(head, body, foot);
  pop.hidden = false;
  rtScrollTop = chat.scrollTop;
  placePop(p, found);
  if (aramaicCache.has(key) && !aramaicCache.get(key).error) return;
  aramaicCache.delete(key);
  postJson('/api/aramaic', { sentence, word: bareWord(phrase) || phrase, language: lang }, 60000)
    .then((r) => aramaicCache.set(key, r), (e) => aramaicCache.set(key, { error: e.message }))
    .then(() => { if (!pop.hidden && pop.contains(body)) { paint(); placePop(p, found); } });
}

function showAcronymPop(p, found) {
  const pop = $('rt-pop');
  const known = expandAcronym(found.word);
  const run = acronymRun(found.text, found.start, found.end).filter((w) => isAcronym(w.word));
  const rtKey = found.word.replace(/[.,;:!?]+$/, '');
  const own = () => state.abbr?.[rtKey] || [];
  let options = [...new Set([...own(), ...(known?.options || [])])];
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
    head.append(el('b', { textContent: found.word.replace(/[.,;:!?]+$/, '') }),
      options.length > 1 ? el('span', { className: 'rt-count', textContent: `${options.length} אפשרויות` }) : '', close);
    body.textContent = '';
    if (!options.length) {
      body.append(el('span', { className: 'rt-none', textContent: 'לא נמצא פענוח במילון.' }));
    } else if (options.length === 1) {
      body.append(el('span', { className: 'rt-text', textContent: options[0] }));
    } else {
      // RTL: the next option is to the left (←), the previous to the right (→)
      const prevB = el('button', { type: 'button', className: 'rt-nav', textContent: '→', title: 'האפשרות הקודמת' });
      const nextB = el('button', { type: 'button', className: 'rt-nav', textContent: '←', title: 'האפשרות הבאה' });
      prevB.disabled = at === 0; nextB.disabled = at === options.length - 1;
      prevB.addEventListener('click', () => { at -= 1; paint(); });
      nextB.addEventListener('click', () => { at += 1; paint(); });
      const dots = el('span', { className: 'rt-dots' }, ...options.map((_, i) => {
        const d = el('button', { type: 'button', className: `rt-dot${i === at ? ' on' : ''}`, title: `אפשרות ${i + 1}` });
        d.addEventListener('click', () => { at = i; paint(); });
        return d;
      }));
      body.append(el('div', { className: 'rt-pager' }, prevB, el('span', { className: 'rt-text', textContent: options[at] }), nextB),
        el('div', { className: 'rt-where' }, el('span', { textContent: `אפשרות ${at + 1} מתוך ${options.length}` }), dots));
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
      const ai = el('button', { type: 'button', className: 'rt-btn', textContent: options.length ? '🔎 לפי ההקשר' : '🔎 בירור לפי ההקשר' });
      ai.addEventListener('click', async () => {
        const words = run.length > 1 ? run.map((w) => w.word) : [found.word];
        ai.disabled = true; ai.textContent = '⏳';
        try {
          // only the sentence the word stands in is sent, not the whole page
          const sentence = sentenceAround(found.text, run.length > 1 ? run[0].start : found.start, run.length > 1 ? run.at(-1).end : found.end);
          const r = await postJson('/api/acronyms', { spec: p.dataset.spec, words: words.map((w) => w.replace(/[.,;:!?]+$/, '')), sentence }, 60000);
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
    // the user's own reading of this abbreviation: kept on this device, shown first
    const mineB = el('button', { type: 'button', className: 'rt-btn', textContent: own().length ? '✎ הפירוש שלי' : '＋ פירוש משלי' });
    mineB.addEventListener('click', () => {
      const v = prompt(`הפירוש שלך ל־${rtKey} (ריק = הסרת הפירוש שלך):`, own()[0] || '');
      if (v === null) return;
      const before = own();
      state.abbr ??= {};
      if (v.trim()) state.abbr[rtKey] = [v.trim().slice(0, 120)]; else delete state.abbr[rtKey];
      save();
      options = [...new Set([...own(), ...options.filter((o) => !before.includes(o))])];
      at = 0;
      paint(); placePop(p, found);
    });
    foot.append(mineB);
    foot.append(el('span', { className: 'rt-note', textContent: 'על דרך אפשר' }));
  };
  if (rtCache.has(rtKey)) options = [...new Set([...own(), ...rtCache.get(rtKey), ...options])];
  paint();
  pop.append(head, body, foot);
  pop.hidden = false;
  rtScrollTop = chat.scrollTop;
  placePop(p, found);
}
chat.addEventListener('click', (e) => {
  if (markerMode || selecting() || !getSelection().isCollapsed) return;
  const p = e.target.closest?.('.hl');
  if (!p || e.target.closest('mark')) return;
  const found = wordAtPoint(p, e.clientX, e.clientY);
  if (found && isAcronym(found.word)) showAcronymPop(p, found);
  else if (found && looksAramaic(found.word)) showAramaicPop(p, found);
  else hideAcronymPop();
});
// selected text → "ארמית" in the tools bar: for a phrase the tap did not recognise
$('tool-aramaic').addEventListener('click', () => {
  const f = selectedRange() || lastRange;
  if (!f) return;
  const [p, start, end] = f;
  const text = p.dataset.text || p.textContent;
  getSelection().removeAllRanges();
  showAramaicPop(p, { word: text.slice(start, end), start, end, text }, text.slice(start, end));
});

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

/**
 * "תרגם": a drop-down in the answer's row that reads as a button. Choosing a language translates an
 * existing analysis (or sets the language of the analysis to come); the current language is ticked.
 */
function langSelect(entry) {
  const a = entry.a;
  const sel = el('select', { className: 'lang-select', title: 'תרגום המענה לשפה אחרת' });
  sel.setAttribute('aria-label', 'תרגום המענה לשפה אחרת');
  const current = a.explanation ? (a.analysisLanguage || '') : (a.replyLanguage || replyLang || '');
  sel.append(el('option', { value: '__', textContent: '🌐 תרגם' }));
  for (const [v, label] of LANGS) sel.append(el('option', { value: v, textContent: `${v === current ? '✓ ' : ''}${label}` }));
  sel.value = '__';
  sel.addEventListener('change', () => {
    const v = sel.value;
    sel.value = '__'; // stays "תרגם"
    if (v === '__') return;
    a.replyLanguage = v || null;
    setReplyLang(v);
    if (a.explanation && v && v !== (a.analysisLanguage || '')) translateEntry(entry, v);
    else { syncEntry(entry); render(); }
  });
  return el('span', { className: 'lang-wrap' }, sel);
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
        const r = await postJson('/api/analysis', { spec, letter: letterOf(entry), replyLanguage: wanted });
        Object.assign(a, {
          explained: true, explanation: r.explanation, translation: r.translation, keyQuote: r.keyQuote, sourceLanguage: r.sourceLanguage,
          provider: r.provider, analysisLanguage: (r.replyLanguage || wanted || '').slice(0, 2),
          highlights: r.highlights || [], sourcesFound: r.sourcesFound || 0, sourcesTotal: r.sourcesTotal || 0, // the passages the explanation rests on
        });
        syncEntry(entry);
        entry.showMore = true; entry.analysisOpen = true; entry.translationOpen = true; // just asked for: shown open
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

  // the analysis (collapsible), with a delete button at its end so a new one can be asked for
  const clear = el('button', { type: 'button', className: 'del-btn', textContent: '🗑 מחיקת הניתוח' });
  clear.addEventListener('click', () => {
    if (!confirm('למחוק את ההסבר, התרגום ושאלות ההמשך? אפשר יהיה לבקש ניתוח חדש.')) return;
    for (const k of ['explanation', 'translation', 'keyQuote', 'sourceLanguage', 'analysisLanguage', 'provider', 'highlights', 'sourcesFound', 'sourcesTotal']) delete a[k];
    a.explained = false;
    delete entry.followups;
    syncEntry(entry);
    render();
  });

  // where the explanation rests: marked on the page image and in the page text
  const marksNote = () => {
    if (!a.highlights) return null;
    const found = a.sourcesFound || 0, total = a.sourcesTotal || 0;
    if (!a.highlights.length) return total ? el('div', { className: 'hl-note', textContent: '🖍 הקטעים שההסבר מבוסס עליהם לא אותרו בעמוד.' }) : null;
    const page = pagerOf(entry).pages[pagerOf(entry).opened];
    const ids = new Set(a.highlights.map((h) => h.id));
    const beyond = (page?.letters || []).filter((l) => ids.has(l.id)).flatMap((l) => [!l.startsOnPage && 'בעמוד הקודם', !l.endsOnPage && 'בעמוד הבא']).filter(Boolean);
    const more = beyond.length ? ` האגרת המסומנת ממשיכה ${[...new Set(beyond)].join(' ו')} – ההסבר מתייחס רק למה שבעמוד שנפתח.` : '';
    const partial = found < total ? ` (${found} מתוך ${total} קטעים אותרו)` : '';
    return el('div', { className: 'hl-note', textContent: `🖍 הקטעים שעליהם מושתת ההסבר מסומנים במרקר על תמונת העמוד ובטקסט שבעמוד${partial}.${more}` });
  };

  // follow-up questions about the analysis – inside the analysis, so minimizing it hides them too
  const qa = entry.followups || [];
  const thread = el('div', { className: 'followups' },
    ...qa.flatMap((f, i) => [
      el('div', { className: 'fq', textContent: f.q }),
      el('div', { className: 'fa' }, pageParagraph(f.a, `F:${entry.id}:${i}`, spec)),
    ]));
  const fu = el('details', { className: 'ana-part fold', open: !!entry.followupsOpen },
    el('summary', {}, el('span', { className: 'sum-label', textContent: `💬 שאלות המשך${qa.length ? ` (${qa.length})` : ''}` })),
    thread);
  fu.addEventListener('toggle', () => { entry.followupsOpen = fu.open; save(); });
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
          spec, letter: letterOf(entry), analysis: { explanation: a.explanation, translation: a.translation }, history: qa, question,
        });
        entry.followups = [...qa, { q: question, a: r.answer, ts: Date.now() }];
        entry.followupsOpen = true;
        syncEntry(entry);
        render();
      } catch (e) {
        status.textContent = e.message; ask.disabled = false; field.disabled = false;
      }
    });
    fu.append(el('div', { className: 'fu-row' }, field, ask), status);
  }

  const translation = a.translation && el('details', { className: 'ana-part fold', open: !!entry.translationOpen },
    el('summary', {}, el('span', { className: 'sum-label', textContent: a.sourceLanguage === 'yiddish' ? '📖 תרגום מאידיש' : '📖 תרגום' })),
    pageParagraph(a.translation, `T:${entry.id}`, spec));
  if (translation) translation.addEventListener('toggle', () => { entry.translationOpen = translation.open; save(); });
  const sub = el('details', { className: 'ana-part fold', open: !!entry.analysisOpen },
    el('summary', {}, el('span', { className: 'sum-label', textContent: '✨ כיצד המענה מתייחס למכתב' })),
    a.keyQuote && el('div', { className: 'quote', textContent: a.keyQuote }),
    pageParagraph(a.explanation, `E:${entry.id}`, spec),
    marksNote(),
    translation,
    (canAsk && spec) || qa.length ? fu : null,
    canAsk && el('div', { className: 'del-row' }, clear));
  sub.addEventListener('toggle', () => { entry.analysisOpen = sub.open; save(); });
  box.append(sub);
  return box;
}

const shownUrls = new Set(); // marked page images that were already loaded once
function answerBubble(entry) {
  const a = entry.a;
  const pager = pagerOf(entry);
  const img = el('img', { className: 'page-img', alt: `עמוד מאגרות קודש, ${a.volumeHeading}`, loading: 'lazy' });
  img.addEventListener('click', () => openLightbox(pager, img.alt, entry));
  img.addEventListener('error', () => pageWrap.replaceWith(el('div', { className: 'note', textContent: 'תמונת העמוד אינה זמינה עוד (נשמרת בשרת לזמן מוגבל). האגרות עצמן שמורות כאן למטה.' })));
  const pageWhere = el('div', { className: 'page-where' });
  const text = pageTextSection(entry, pager);
  const where = () => [pager.at === pager.opened ? '' : `📖 ${whereLabel(pager)}`, hlNote(entry, pager)].filter(Boolean).join(' · ');
  const pageWrap = el('div', { className: 'page-wrap' }, img, el('span', { className: 'page-wait', textContent: '🖍 מסמנים בעמוד את הקטעים שעליהם נשען ההסבר…' }));
  let swap = 0;
  const paintPage = () => {
    const page = currentPage(pager);
    const url = pageImageUrl(entry, page);
    const plain = url.split('?')[0];
    if (url === plain || shownUrls.has(url) || img.getAttribute('src') === url) { swap += 1; pageWrap.classList.remove('loading'); img.src = url; } else {
      // the marked image takes a moment to draw: the page stays, with an animation over it, and is replaced when ready
      if (!img.getAttribute('src')) img.src = plain;
      const mine = ++swap;
      pageWrap.classList.add('loading');
      const pre = new Image();
      pre.onload = pre.onerror = () => { shownUrls.add(url); if (mine !== swap) return; img.src = url; pageWrap.classList.remove('loading'); };
      pre.src = url;
    }
    pageWhere.textContent = where();
    text.paint();
  };
  pager.onChange = paintPage;
  pager.onNav = () => { pageWhere.textContent = where(); text.nav(); };
  paintPage();
  prefetchAround(pager); // the pages before and after are ready before the user turns to them

  const wrap = el('div', { className: 'fav-wrap' }, favPanel(entry));
  // the row: its label, "תרגם", the star – and the chevron at the left end (like every other row)
  const summary = el('summary', {}, el('span', { className: 'more-label sum-label', textContent: a.explanation ? 'הסבר והטקסט שבעמוד' : 'ניתוח והטקסט שבעמוד' }), langSelect(entry));
  const paintStar = () => { summary.querySelector('.star')?.remove(); summary.append(favStar(entry, () => { paintStar(); wrap.replaceChildren(favPanel(entry)); })); };
  paintStar();
  summary.querySelector('.lang-select').addEventListener('click', (e) => e.stopPropagation()); // inside a <summary>: do not open / close
  const more = el('details', { className: 'more fold' },
    summary,
    analysisSection(entry),
    text.box,
    el('div', { className: 'note', textContent: 'העמוד מורכב מהטקסט המקוון של אגרות הקודש, ועימודו אינו זהה לעימוד הספר המודפס. ההסבר הוא הצעה להבנה בלבד ואינו פסק הלכה; לשאלות מעשיות – יש להתייעץ עם רב. סימון טקסט פותח כלים: הדגשה, גודל טקסט, PDF ושיתוף.' }));
  more.open = !!entry.showMore;
  // the tags sit right under the row with the star, whether the row is open or closed
  const placeTags = () => { if (more.open) summary.after(wrap); else more.after(wrap); };
  more.addEventListener('toggle', () => { entry.showMore = more.open; save(); placeTags(); });

  const fold = el('button', { type: 'button', className: 'chev', textContent: '▴', title: 'מזעור המענה' });
  fold.setAttribute('aria-label', 'מזעור המענה');
  fold.addEventListener('click', () => { collapseEntry(entry); save(); render(); });
  const bubble = el('div', { className: 'msg them' },
    el('div', { className: 'ans-head' }, el('h3', { textContent: `✉️ אגרות קודש · ${a.volumeHeading}` }), fold),
    pageWhere,
    pageWrap,
    more,
    time(entry.ts));
  placeTags();
  return bubble;
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
  prefsWatcher = cloud.watchPrefs(onPrefs, (e) => console.warn('backup', e));
  if (pendingJoin) joinNow();
}

// ---------- backup of favourites (+ tags) and highlights in the Google account ----------
// Per user, private (users/{uid}/private/favs|marks). Every item keeps the time it was last changed,
// so devices merge item by item: the newer change wins, and nothing is lost when two devices edit.
let prefsWatcher = null;
state.prefTs ||= { favs: {}, marks: {} }; // key → time of the last change known on this device
state.cloudFavs ||= {};                   // backed-up favourites of letters not on this device yet
const prefQueue = { favs: {}, marks: {} };
let prefTimer = null;
let prefWarned = false;

function prefChanged(name, key, v) {
  const ts = Date.now();
  state.prefTs[name][key] = ts;
  prefQueue[name][key] = { v, ts };
  save();
  clearTimeout(prefTimer);
  prefTimer = setTimeout(pushPrefs, 1200);
}
function favChanged(entry) { prefChanged('favs', entry.id, entry.fav ? [...entry.fav.tags] : null); }
function markChanged(key) { prefChanged('marks', key, state.marks[key]?.length ? state.marks[key].flat() : null); }
const toRanges = (flat) => { const out = []; for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

async function pushPrefs() {
  if (!user || !cloud) return; // signed out: everything is sent when signing in (onPrefs)
  for (const name of ['favs', 'marks']) {
    const items = prefQueue[name];
    if (!Object.keys(items).length) continue;
    prefQueue[name] = {};
    try {
      await cloud.savePrefs(name, items);
    } catch (e) {
      prefQueue[name] = { ...items, ...prefQueue[name] }; // try again later
      console.warn('backup failed', e);
      if (!prefWarned) { prefWarned = true; toast('הגיבוי של המועדפים וההדגשות לחשבון לא הצליח – ננסה שוב.'); }
      clearTimeout(prefTimer);
      prefTimer = setTimeout(pushPrefs, 60000);
      return;
    }
  }
}

function applyFav(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return false;
  const tags = state.cloudFavs[id];
  delete state.cloudFavs[id];
  if (tags) e.fav = { tags: [...tags] }; else { delete e.fav; delete e.tagsOpen; }
  return true;
}
const localPref = (name, key) => (name === 'favs'
  ? (state.entries.find((e) => e.id === key)?.fav?.tags ?? state.cloudFavs[key] ?? null)
  : (state.marks[key]?.length ? state.marks[key].flat() : null));

/** The account's copy arrived: take what is newer there, send what is newer here. */
function onPrefs(name, items) {
  const known = state.prefTs[name];
  let changed = false;
  for (const [key, it] of Object.entries(items)) {
    if (!it || typeof it.ts !== 'number' || (known[key] || 0) >= it.ts) continue;
    known[key] = it.ts;
    changed = true;
    if (name === 'favs') { state.cloudFavs[key] = Array.isArray(it.v) ? it.v : null; applyFav(key); }
    else if (Array.isArray(it.v) && it.v.length) state.marks[key] = toRanges(it.v);
    else delete state.marks[key];
  }
  const local = name === 'favs' ? state.entries.filter((e) => e.fav).map((e) => e.id) : Object.keys(state.marks);
  for (const key of new Set([...local, ...Object.keys(known)])) {
    const remote = items[key];
    if (remote && remote.ts >= (known[key] || 0)) continue; // the account is up to date
    const v = localPref(name, key);
    if (!remote && v == null) continue;                        // nothing to back up
    known[key] ||= Date.now();                                 // saved before the backup existed
    prefQueue[name][key] = { v, ts: known[key] };
  }
  if (Object.keys(prefQueue[name]).length) { clearTimeout(prefTimer); prefTimer = setTimeout(pushPrefs, 300); }
  if (changed) { save(); renderSoon(); }
}

function stopWatching() {
  prefsWatcher?.(); prefsWatcher = null;
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
      else state.convs.push({ ...fields, cloud: true, readTs: Date.now() });
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
      const conv = convById(id);
      const merged = list.map((d) => {
        const before = keep.get(d.id);
        const fresh = d.a && !before?.a && !inFlight.has(d.id) && conv?.readTs && d.ts > conv.readTs - 5 * 60e3;
        const e = Object.assign(before || {}, d, { conv: id }); // keeps fav / collapsed / unread
        if (fresh && !(view.name === 'chat' && view.id === id && !document.hidden)) { e.unread = true; collapseEntry(e); }
        if (fresh) SOUND.answer();
        return e;
      });
      const pending = entriesOf(id).filter((e) => (e.pending || e.draft || (e.kind && e.error && !e.a)) && !list.some((d) => d.id === e.id));
      state.entries = state.entries.filter((e) => e.conv !== id).concat(merged, pending);
      for (const e of merged) if (e.id in state.cloudFavs) applyFav(e.id); // favourites backed up before the letter arrived
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
  // read / unread: answers in a chat, or whole chats in the list
  const answered = entries.map((id) => state.entries.find((e) => e.id === id)).filter((e) => e?.a);
  const anyUnread = convs.length ? convs.some((c) => unreadCount(c) || c.markedUnread) : answered.some(isUnread);
  $('sel-read').hidden = !convs.length && !answered.length;
  $('sel-read').textContent = anyUnread ? '✓' : '●';
  $('sel-read').title = anyUnread ? 'סימון כנקרא' : 'סימון כלא נקרא';
  $('sel-read').setAttribute('aria-label', $('sel-read').title);
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

const entryText = (e) => `${e.qLocked ? '🔒 מכתב נעול' : e.q}${e.a ? `\n✉️ ${e.a.title}` : ''}`;
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
  if (!confirm(n === 1 ? `לגנוז${what}? הפריט יימחק מהשיחה.` : `לגנוז ${n} פריטים${what}? הם יימחקו מהשיחה.`)) return;
  const failed = [];
  for (const id of entries) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) continue;
    if (conv?.cloud && user) await cloud.deleteEntry(conv.id, id).catch(() => failed.push(id));
    if (!failed.includes(id)) {
      if (e.fav) { delete e.fav; favChanged(e); } // the favourite goes from the backup too
      dropMedia(e);
      state.entries = state.entries.filter((x) => x !== e); pagers.delete(id);
    }
  }
  for (const id of msgs) {
    if (conv?.cloud && user) await cloud.deleteMessage(conv.id, id).catch(() => failed.push(id));
    if (!failed.includes(id)) state.messages = state.messages.filter((m) => m.id !== id);
  }
  clearSelection(); save(); render();
  if (failed.length) alert('חלק מהפריטים לא נגנזו. נסו שוב.');
});
$('sel-archive').addEventListener('click', () => toggleArchive(selected('c').map(convById).filter(Boolean)));
$('sel-read').addEventListener('click', () => {
  const convs = selected('c').map(convById).filter(Boolean);
  if (convs.length) {
    const read = convs.some((c) => unreadCount(c) || c.markedUnread);
    for (const c of convs) {
      if (read) { for (const e of entriesOf(c.id)) setRead(e); c.readTs = Date.now(); delete c.markedUnread; } else c.markedUnread = true;
    }
  } else {
    const list = selected('e').map((id) => state.entries.find((e) => e.id === id)).filter((e) => e?.a);
    const read = list.some(isUnread);
    for (const e of list) { setRead(e, read); if (!read) collapseEntry(e); }
  }
  clearSelection(); save(); render();
});
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
    if (user && cloud && e.a) { // drafts and letters still waiting stay on this device until answered
      if (target.cloud) cloud.saveEntry(target.id, e).catch((err) => console.warn('not moved to the account', err));
      if (from.cloud) cloud.deleteEntry(old, e.id).catch((err) => console.warn('not removed from the account', err));
    }
  }
  clearSelection(); save(); render();
  toast(`הועבר אל "${target.title}"`);
}

// ---------- a photographed page and a letter by voice ----------
// The photo and the recording stay on this device (IndexedDB); the cloud gets only a small thumbnail of the photo.
// Both start as a draft in the chat: the user approves (sends) or deletes it.
const media = (() => {
  const mem = new Map(); // also a fallback where IndexedDB is blocked
  let dbp = null;
  const open = () => (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('mlr-media', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('m', mode);
      const req = fn(tx.objectStore('m'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    async put(k, blob) { mem.set(k, blob); await run('readwrite', (s) => s.put(blob, k)).catch((e) => console.warn('media', e)); },
    async get(k) { return mem.get(k) || (await run('readonly', (s) => s.get(k)).catch(() => null)) || null; },
    del(k) { mem.delete(k); return run('readwrite', (s) => s.delete(k)).catch(() => {}); },
    keys: () => run('readonly', (s) => s.getAllKeys()).catch(() => []),
  };
})();
const imgKey = (e) => `img:${e.id}`;
const audKey = (e) => `aud:${e.id}`;
const mediaUrls = new Map(); // key → object URL
async function mediaUrl(key) {
  if (mediaUrls.has(key)) return mediaUrls.get(key);
  const blob = await media.get(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  mediaUrls.set(key, url);
  return url;
}
function dropMedia(entry) {
  for (const k of [imgKey(entry), audKey(entry)]) {
    media.del(k);
    if (mediaUrls.has(k)) { URL.revokeObjectURL(mediaUrls.get(k)); mediaUrls.delete(k); }
  }
  players.get(entry.id)?.pause(); players.delete(entry.id);
}
// recordings and photos of letters that are gone (deleted, trimmed, removed on another device) are removed too
setTimeout(async () => {
  const ids = new Set(state.entries.map((e) => e.id));
  for (const k of await media.keys()) if (!ids.has(String(k).slice(4))) media.del(k);
}, 15000);

function removeEntry(entry) {
  dropMedia(entry);
  state.entries = state.entries.filter((x) => x !== entry);
  pagers.delete(entry.id);
  save(); render();
}

const PHOTO_Q = 'צילום עמוד מאגרות קודש';
const fmtDur = (s) => { const t = Math.max(0, Math.round(s || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const ICONS = {
  mic: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V5.5a3.5 3.5 0 0 0-7 0V11a3.5 3.5 0 0 0 3.5 3.5zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.9V19H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.1a6 6 0 0 0 5-5.9z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="currentColor" d="M7 4.5v15l12.5-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="currentColor" d="M6.5 4.5h4v15h-4zm7 0h4v15h-4z"/></svg>',
};

// ---- choosing a photo: the camera or the gallery ----
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}
function scaledJpeg(img, max, quality) {
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
}
const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result)); r.onerror = reject;
  r.readAsDataURL(blob);
});
async function addPhoto(file) {
  const conv = convById(view.id);
  if (!conv || !isOwner(conv) || !file) return;
  // the bubble appears at once, with a progress line, and gets the picture when it is ready
  const entry = { id: newId(), conv: conv.id, ts: Date.now(), kind: 'photo', draft: true, preparing: true, q: PHOTO_Q, t0: Date.now() };
  state.entries.push(entry);
  render({ scroll: true });
  try {
    const img = await loadImage(file);
    const full = await scaledJpeg(img, 2000, 0.85); // sharp enough to read the numbers, small enough to send
    entry.thumb = await blobToDataUrl(await scaledJpeg(img, 360, 0.6));
    await media.put(imgKey(entry), full);
  } catch {
    removeEntry(entry);
    toast('לא ניתן לפתוח את הקובץ. בחרו תמונה (JPG או PNG).');
    return;
  }
  if (!state.entries.includes(entry)) return;
  delete entry.preparing;
  save(); render({ scroll: true });
}

/** A line of progress inside a bubble: a spinner, what is happening now (by the time passed), the time, and a running bar. */
function progressLine(entry, stages) {
  const text = el('span');
  const line = el('div', { className: 'progress' },
    el('div', { className: 'wait-line' }, el('span', { className: 'spinner' }), text), el('div', { className: 'bar-run' }, el('i')));
  const paint = () => {
    const t = Math.max(0, (Date.now() - (entry.t0 || Date.now())) / 1000);
    text.textContent = `${[...stages].reverse().find(([at]) => t >= at)[1]} ${fmtDur(t)}`;
  };
  paint();
  const timer = setInterval(() => { if (line.isConnected) paint(); else clearInterval(timer); }, 1000);
  return line;
}
/** A letter the user may add to a photo or a recording – also while it is being processed. */
function noteBox(entry, placeholder) {
  const ta = el('textarea', { className: 'draft-text note', value: entry.note || '', placeholder, dir: 'auto', maxLength: 8000 });
  ta.dataset.fid = `note:${entry.id}`;
  ta.addEventListener('input', () => { entry.note = ta.value; save(); });
  return ta;
}
const pickPhoto = (from) => $(from === 'camera' ? 'pick-camera' : 'pick-gallery').click();
for (const id of ['pick-camera', 'pick-gallery']) {
  $(id).addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; addPhoto(f); });
}
$('camera').addEventListener('click', () => pickPhoto('camera'));
$('attach').addEventListener('click', () => pickPhoto('gallery'));
function choosePhotoAgain(anchor) {
  showMenu(anchor, [
    { label: '📷 צילום במצלמה', onClick: () => pickPhoto('camera') },
    { label: '📎 בחירה מהגלריה', onClick: () => pickPhoto('gallery') },
  ]);
}

/** Full-screen view of the photo; a tap closes it. */
function showPhoto(src) {
  const box = el('div', { className: 'photo-view' }, el('img', { src, alt: 'הצילום' }));
  box.addEventListener('click', () => box.remove());
  document.body.append(box);
}

// ---- approving or deleting a draft ----
function draftActions(entry, okLabel, onOk) {
  const ok = el('button', { type: 'button', className: 'ok', textContent: okLabel });
  ok.addEventListener('click', onOk);
  const del = el('button', { type: 'button', className: 'del', textContent: '🗑 מחיקה' });
  del.addEventListener('click', () => removeEntry(entry));
  return el('div', { className: 'draft-actions' }, ok, del);
}
function sendDraft(entry) {
  if (isNativeApp && !API && !askServer()) return;
  const conv = convById(entry.conv);
  if (!conv || !isOwner(conv)) return;
  if (entry.kind === 'voice') {
    entry.q = String(entry.q || '').trim();
    if (entry.q.length < 2) { toast('אין טקסט לשליחה. הקליטו שוב או מחקו.'); return; }
  }
  if (conv.title === 'שיחה חדשה' && !entriesOf(conv.id).some((e) => e.a) && entry.kind === 'voice') {
    conv.title = conv.autoTitle = entry.q.split(/\s+/).slice(0, 5).join(' ').slice(0, 40);
    if (conv.cloud) cloud.renameConv(conv.id, conv.title).catch(() => {});
  }
  delete entry.draft; delete entry.error; delete entry.errorCode;
  if (entry.kind === 'photo') entry.q = PHOTO_Q;
  entry.ts = entry.t0 = Date.now();
  if (!entry.sum) summarizeEntry(entry);
  entry.pending = true;
  entry.lang = replyLang || undefined;
  save(); render({ scroll: true });
  askNotifyPermission();
  requestAnswer(entry);
}

function photoBody(entry) {
  if (entry.preparing) return [progressLine(entry, [[0, 'טוענים את התמונה…']])];
  const img = el('img', { className: 'photo-img', alt: 'צילום עמוד מאגרות קודש', src: entry.thumb || '' });
  mediaUrl(imgKey(entry)).then((u) => { if (u) img.src = u; });
  img.addEventListener('click', () => { if (!selecting()) showPhoto(img.src); });
  const parts = [el('div', { className: `photo-wrap${entry.pending ? ' scanning' : ''}` }, img)];
  if (entry.draft) {
    parts.push(el('div', { className: 'draft-tag', textContent: 'הצילום טרם נשלח. בשליחה יזוהו מספר העמוד ומספרי האגרות, והטקסט יובא מהמאגר.' }),
      noteBox(entry, 'אפשר לצרף כאן מכתב לרבי (לא חובה)…'),
      draftActions(entry, '✓ שליחה לעיבוד', () => sendDraft(entry)));
  } else if (entry.pending) {
    parts.push(progressLine(entry, [[0, 'שולחים את הצילום…'], [3, 'קוראים את מספר העמוד ומספרי האגרות…'], [10, 'מביאים את האגרת מהמאגר…'], [25, 'עוד רגע – השרת מתעורר…']]),
      noteBox(entry, 'בינתיים אפשר לכתוב כאן מכתב לרבי שיצורף לצילום…'));
  } else {
    if (entry.q && entry.q !== PHOTO_Q) parts.push(el('div', { className: 'photo-read', textContent: entry.q }));
    if (String(entry.note || '').trim()) parts.push(el('p', { className: 'voice-text', textContent: entry.note.trim() }));
  }
  return parts;
}

// ---- the recording player (like a messaging app) ----
const players = new Map(); // entry id → Audio, kept across re-renders
function voicePlayer(entry) {
  const v = entry.voice || {};
  const dur = v.dur || 0;
  const wave = v.wave?.length ? v.wave : Array(36).fill(0.35);
  const bars = wave.map((h) => el('i', { style: `height:${Math.round(18 + 82 * Math.min(1, h))}%` }));
  const dot = el('span', { className: 'v-dot' });
  const waveBox = el('div', { className: 'v-wave' }, ...bars, dot);
  const length = el('span', { textContent: fmtDur(dur) });
  const play = el('button', { type: 'button', className: 'v-play', title: 'השמעת ההקלטה' });
  play.setAttribute('aria-label', 'השמעת ההקלטה');
  const avatar = user?.photoURL
    ? el('img', { src: user.photoURL, alt: '', referrerPolicy: 'no-referrer' })
    : el('span', { className: 'v-initial', textContent: (user?.displayName || 'א').trim()[0] });
  const mic = el('span', { className: 'v-mic' });
  mic.innerHTML = ICONS.mic.replace('width="26" height="26"', 'width="22" height="22"');
  const paint = (t, on) => {
    const p = dur ? Math.min(1, t / dur) : 0;
    bars.forEach((b, i) => b.classList.toggle('on', (i + 0.5) / bars.length <= p));
    dot.style.left = `${p * 100}%`;
    length.textContent = fmtDur(on || t > 0 ? t : dur);
    play.innerHTML = on ? ICONS.pause : ICONS.play;
  };
  const bind = (audio) => {
    audio.ontimeupdate = () => paint(audio.currentTime, !audio.paused);
    audio.onplay = audio.onpause = () => paint(audio.currentTime, !audio.paused);
    audio.onended = () => { audio.currentTime = 0; paint(0, false); };
  };
  const existing = players.get(entry.id);
  if (existing) { bind(existing); paint(existing.currentTime, !existing.paused); } else paint(0, false);
  const audioOf = async () => {
    let audio = players.get(entry.id);
    if (audio) return audio;
    const url = await mediaUrl(audKey(entry));
    if (!url) return null;
    audio = new Audio(url);
    players.set(entry.id, audio);
    bind(audio);
    return audio;
  };
  mediaUrl(audKey(entry)).then((u) => { if (!u) { play.disabled = true; play.title = 'ההקלטה שמורה רק במכשיר שבו הוקלטה'; } });
  play.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (selecting()) return;
    const audio = await audioOf();
    if (!audio) { toast('ההקלטה שמורה רק במכשיר שבו הוקלטה.'); return; }
    if (audio.paused) {
      for (const [id, other] of players) if (id !== entry.id) other.pause();
      audio.play().catch(() => toast('לא ניתן להשמיע את ההקלטה.'));
    } else audio.pause();
  });
  waveBox.addEventListener('click', async (e) => {
    if (selecting() || !dur) return;
    const r = waveBox.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const audio = await audioOf();
    if (!audio) return;
    audio.currentTime = p * dur;
    paint(audio.currentTime, !audio.paused);
  });
  const clock = new Date(entry.ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return el('div', { className: 'voice' },
    el('div', { className: 'v-avatar' }, avatar, mic),
    el('div', { className: 'v-main' }, waveBox, el('div', { className: 'v-meta' }, el('span', { textContent: clock }), length)),
    play);
}

function voiceBody(entry) {
  const parts = [voicePlayer(entry)];
  if (!entry.draft) { parts.push(el('p', { className: 'voice-text', textContent: entry.q })); return parts; }
  if (entry.transcribing) {
    parts.push(progressLine(entry, [[0, 'שולחים את ההקלטה…'], [3, 'ממירים את הדיבור לטקסט…'], [20, 'עוד רגע – השרת מתעורר…']]),
      noteBox(entry, 'בינתיים אפשר לכתוב כאן מכתב לרבי שיצורף להקלטה…'));
  } else if (entry.error) {
    const again = el('button', { type: 'button', className: 'ok', textContent: '↻ נסו שוב' });
    again.addEventListener('click', () => transcribeEntry(entry));
    const del = el('button', { type: 'button', className: 'del', textContent: '🗑 מחיקה' });
    del.addEventListener('click', () => removeEntry(entry));
    parts.push(el('div', { className: 'error', textContent: entry.error }), el('div', { className: 'draft-actions' }, again, del));
  } else {
    const ta = el('textarea', { className: 'draft-text', value: entry.q || '', dir: 'auto' });
    ta.dataset.fid = `draft:${entry.id}`;
    ta.setAttribute('aria-label', 'הטקסט שזוהה בהקלטה');
    ta.addEventListener('input', () => { entry.q = ta.value; save(); });
    parts.push(el('div', { className: 'draft-tag', textContent: 'זה הטקסט שזוהה בהקלטה. אפשר לתקן אותו, ואז לשלוח לרבי או למחוק.' }), ta,
      draftActions(entry, '✓ שליחה לרבי', () => sendDraft(entry)));
  }
  return parts;
}

async function transcribeEntry(entry) {
  entry.transcribing = true; delete entry.error;
  entry.t0 = Date.now();
  save(); render();
  try {
    const blob = await media.get(audKey(entry));
    if (!blob) throw new Error('ההקלטה אינה שמורה עוד במכשיר. מחקו והקליטו שוב.');
    const data = await postJson('/api/transcribe', { audio: await blobToBase64(blob), mimeType: blob.type || 'audio/webm' });
    // what the user wrote while waiting comes first, then the words of the recording
    entry.q = [String(entry.note || '').trim(), data.text].filter(Boolean).join('\n\n');
    delete entry.note;
  } catch (e) {
    entry.error = String(e?.message || e).replace('הניתוח לוקח', 'ההמרה לוקחת');
  }
  delete entry.transcribing;
  if (!state.entries.includes(entry)) return;
  save(); render();
}

// ---- recording ----
const MAX_REC = 180; // seconds
const rec = { active: false, mr: null, stream: null, chunks: [], levels: [], start: 0, timer: null, ctx: null, sample: null, conv: null, cancel: false, dur: 0 };
async function startRecording(locked = true) {
  if (isNativeApp && !API && !askServer()) return;
  const conv = convById(view.id);
  if (!conv || !isOwner(conv) || rec.active || rec.starting) return;
  rec.starting = true;
  try { await beginRecording(conv, locked); } finally { rec.starting = false; }
}
async function beginRecording(conv, locked) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('הקלטה אינה נתמכת במכשיר זה.'); return; }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast('אין גישה למיקרופון. אפשרו את ההרשאה בהגדרות ונסו שוב.');
    return;
  }
  if (!locked && !hold) { // the finger left before the microphone was ready (e.g. while Android asked for permission)
    rec.stream.getTracks().forEach((t) => t.stop());
    toast('להקלטה: החזיקו את המיקרופון לחוץ ודברו. משיכה מעלה נועלת את ההקלטה.');
    return;
  }
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t));
  rec.mr = new MediaRecorder(rec.stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  Object.assign(rec, { active: true, locked, chunks: [], levels: [], cancel: false, conv: conv.id, sample: null });
  SOUND.recStart();
  navigator.vibrate?.(30);
  rec.mr.ondataavailable = (e) => { if (e.data?.size) rec.chunks.push(e.data); };
  rec.mr.onstop = finishRecording;
  try { // loudness, for the waveform
    rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = rec.ctx.createAnalyser();
    an.fftSize = 1024;
    rec.ctx.createMediaStreamSource(rec.stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    rec.sample = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const b of buf) { const d = (b - 128) / 128; sum += d * d; }
      rec.levels.push(Math.sqrt(sum / buf.length));
    };
  } catch { rec.ctx = null; }
  rec.mr.start(1000);
  rec.start = Date.now();
  $('rec-time').textContent = '0:00';
  rec.timer = setInterval(() => {
    rec.sample?.();
    const t = (Date.now() - rec.start) / 1000;
    $('rec-time').textContent = fmtDur(Math.floor(t));
    if (t >= MAX_REC) { stopRecording(); toast('ההקלטה הגיעה לאורך המרבי (3 דקות).'); }
  }, 100);
  paintRecording();
}
function stopRecording(cancel = false) {
  if (!rec.active) return;
  rec.active = false;
  rec.cancel = cancel;
  (cancel ? SOUND.recCancel : SOUND.recStop)();
  rec.dur = (Date.now() - rec.start) / 1000;
  clearInterval(rec.timer);
  try { if (rec.mr.state !== 'inactive') rec.mr.stop(); } catch { /* already stopped */ }
  rec.stream?.getTracks().forEach((t) => t.stop());
  rec.ctx?.close().catch(() => {});
  paintRecording();
}
/** Loudness samples → n bars between 0 and 1. */
function waveOf(levels, n = 36) {
  if (!levels.length) return [];
  const out = Array.from({ length: n }, (_, i) => {
    const part = levels.slice(Math.floor((i * levels.length) / n), Math.max(Math.floor(((i + 1) * levels.length) / n), Math.floor((i * levels.length) / n) + 1));
    return Math.max(...part);
  });
  const top = Math.max(...out) || 1;
  return out.map((v) => Math.round(Math.sqrt(v / top) * 100) / 100);
}
async function finishRecording() {
  const mr = rec.mr;
  rec.mr = null;
  if (rec.cancel) return;
  if (rec.dur < 1) { toast('ההקלטה קצרה מדי. החזיקו את המיקרופון לחוץ ודברו; משיכה מעלה נועלת את ההקלטה.'); return; }
  const conv = convById(rec.conv);
  if (!conv) return;
  const blob = new Blob(rec.chunks, { type: (mr?.mimeType || 'audio/webm') });
  const entry = { id: newId(), conv: conv.id, ts: Date.now(), kind: 'voice', draft: true, transcribing: true, t0: Date.now(), q: '', voice: { dur: Math.round(rec.dur), wave: waveOf(rec.levels) } };
  state.entries.push(entry); // the bubble appears at once
  render({ scroll: true });
  await media.put(audKey(entry), blob);
  transcribeEntry(entry);
}
function paintRecording() {
  $('pill').hidden = rec.active;
  $('rec-bar').hidden = !rec.active;
  $('rec-lock').hidden = !(rec.active && !rec.locked);
  $('rec-label').textContent = rec.locked ? '🔒 ההקלטה נעולה – לחצו ✓ לסיום' : 'שחררו לסיום · משכו מעלה לנעילה';
  $('rec-cancel').hidden = !rec.locked;
  paintSend();
}
$('rec-cancel').addEventListener('click', () => stopRecording(true));
function lockRecording() {
  if (!rec.active || rec.locked) return;
  rec.locked = true;
  navigator.vibrate?.(30);
  paintRecording();
}
// Hold the microphone to record and let go to finish; pull it up to lock (then ✓ finishes); slide sideways to cancel.
let hold = null; // where the finger went down on the microphone
let skipSubmit = false; // the click that follows a hold must not start anything
send.addEventListener('pointerdown', (e) => {
  skipSubmit = false;
  if (send.dataset.kind !== 'mic' || rec.active || e.button) return;
  e.preventDefault();
  skipSubmit = true;
  hold = { x: e.clientX, y: e.clientY };
  try { send.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  startRecording(false);
});
send.addEventListener('pointermove', (e) => {
  if (!hold || !rec.active || rec.locked) return;
  if (hold.y - e.clientY > 60) lockRecording();
  else if (Math.abs(e.clientX - hold.x) > 90) { hold = null; stopRecording(true); toast('ההקלטה בוטלה'); }
});
for (const ev of ['pointerup', 'pointercancel']) {
  send.addEventListener(ev, () => {
    if (!hold) return;
    hold = null;
    if (rec.active && !rec.locked) stopRecording();
  });
}
send.addEventListener('contextmenu', (e) => e.preventDefault());
// a recording that was being converted when the app closed: convert it again
setTimeout(() => { for (const e of state.entries) if (e.transcribing) transcribeEntry(e); }, 0);

/** The round button: a microphone while the letter box is empty, the send arrow once there is text, ✓ while recording. */
function paintSend() {
  const mic = !rec.active && toRebbe && !input.value.trim();
  const kind = rec.active ? (rec.locked ? 'check' : 'holding') : mic ? 'mic' : 'arrow';
  if (send.dataset.kind === kind) return;
  send.dataset.kind = kind;
  send.className = `send${kind === 'arrow' ? ' arrow' : kind === 'holding' ? ' holding' : ''}`;
  send.innerHTML = ICONS[kind === 'holding' ? 'mic' : kind];
  const label = { check: 'סיום ההקלטה', holding: 'מקליט – שחררו לסיום', mic: 'הקלטת מכתב בקול: החזיקו לחוץ', arrow: 'שליחה' }[kind];
  send.setAttribute('aria-label', label);
  send.title = label;
}

// ---- a sent letter folds to one short line (written by the AI, editable); it can be locked behind the fingerprint ----
const unlockedQ = new Set(); // locked letters that were opened in this session
const letterOf = (e) => (e.kind === 'photo' ? (String(e.note || '').trim() || e.q) : e.q);
const shortLine = (t, n = 8) => { const w = String(t || '').trim().split(/\s+/); return w.length > n ? `${w.slice(0, n).join(' ')}…` : w.join(' '); };
const sumOf = (e) => e.sum || shortLine(e.kind === 'photo' && !String(e.note || '').trim() ? e.q.replace(`${PHOTO_Q} – `, '') : letterOf(e));
const qSealed = (e) => !!e.qLocked && !unlockedQ.has(e.id);
const folds = (e) => !e.draft && !(e.kind === 'photo' && e.pending) && (!!e.kind || !!e.qLocked || String(e.q || '').length > 70);
async function openLetter(entry) {
  if (qSealed(entry)) {
    if (!await authenticate('פתיחת המכתב הנעול')) return;
    unlockedQ.add(entry.id);
  }
  entry.qOpen = true;
  save(); render();
}
async function toggleLetterLock(entry) {
  if (!await canAuthenticate()) { toast('במכשיר זה אין טביעת אצבע או נעילת מסך.'); return; }
  if (entry.qLocked) {
    if (!await authenticate('ביטול נעילת המכתב')) return;
    delete entry.qLocked; unlockedQ.delete(entry.id);
  } else {
    entry.qLocked = true; delete entry.qOpen; unlockedQ.delete(entry.id);
    toast('🔒 המכתב ננעל במכשיר זה. פתיחה – בטביעת אצבע.');
  }
  save(); render();
}
function editSummary(entry) {
  const v = prompt('שורה קצרה שתוצג כשהמכתב מכווץ (ריק = ניסוח אוטומטי):', sumOf(entry));
  if (v === null) return;
  if (v.trim()) { entry.sum = v.trim().slice(0, 80); entry.sumEdited = true; } else { delete entry.sum; delete entry.sumEdited; }
  if (entry.a) syncEntry(entry); else save();
  render();
}
/** Asks the AI for a name for the chat (first letter) and a one-line summary of the letter. */
async function summarizeEntry(entry) {
  const text = letterOf(entry);
  if (!text || text === PHOTO_Q || text.trim().split(/\s+/).length < 4) return; // a very short letter is its own summary
  try {
    const r = await postJson('/api/summary', { letter: text }, 60000);
    if (!state.entries.includes(entry)) return;
    if (r.line && !entry.sumEdited) entry.sum = r.line;
    const conv = convById(entry.conv);
    if (r.title && conv?.autoTitle && conv.autoTitle === conv.title) { // still the provisional name (first words)
      conv.title = r.title;
      if (conv.cloud && cloud) cloud.renameConv(conv.id, conv.title).catch(() => {});
    }
    if (conv) delete conv.autoTitle;
    if (entry.a) syncEntry(entry); else save();
    render();
  } catch (e) { console.warn('summary', e); }
}

function questionBubble(entry, conv) {
  const tools = el('div', { className: 'q-tools' });
  if (entry.a) {
    const b = el('button', { type: 'button', className: 'chev', textContent: entry.collapsed ? '▾' : '▴', title: entry.collapsed ? 'הרחבת המענה' : 'מזעור המענה' });
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', () => { if (entry.collapsed) expandEntry(entry); else { collapseEntry(entry); save(); render(); } });
    tools.append(b);
  }
  const mine = isOwner(conv);
  const who = mine ? 'אני' : nameOf(conv, conv.owner);
  const folding = folds(entry);
  const open = !folding || (entry.qOpen && !qSealed(entry));
  let body;
  if (!open) { // one short line; a tap opens the letter
    const sealed = qSealed(entry);
    const line = el('button', { type: 'button', className: 'q-sum', title: sealed ? 'פתיחה בטביעת אצבע' : 'הצגת המכתב המלא' },
      el('span', { className: 'q-sum-icon', textContent: sealed ? '🔒' : entry.kind === 'voice' ? '🎤' : entry.kind === 'photo' ? '📷' : '✉️' }),
      el('span', { className: 'q-sum-text', textContent: sealed ? 'מכתב נעול – לחצו לפתיחה' : sumOf(entry) }),
      el('span', { className: 'chev', textContent: '▾' }));
    line.addEventListener('click', () => { if (!selecting()) openLetter(entry); });
    body = [line];
  } else {
    body = entry.kind === 'photo' ? photoBody(entry) : entry.kind === 'voice' ? voiceBody(entry) : [el('p', { textContent: entry.q })];
    if (folding || (!entry.draft && mine && !entry.kind)) {
      const row = el('div', { className: 'q-row' });
      const btn = (text, title, fn) => { const b = el('button', { type: 'button', textContent: text, title }); b.addEventListener('click', () => { if (!selecting()) fn(); }); row.append(b); };
      if (folding) btn('▴ כיווץ', 'כיווץ המכתב לשורה אחת', () => { delete entry.qOpen; if (entry.qLocked) unlockedQ.delete(entry.id); save(); render(); });
      if (mine && folding) btn('✎ שורת סיכום', 'עריכת השורה שמוצגת כשהמכתב מכווץ', () => editSummary(entry));
      if (mine) btn(entry.qLocked ? '🔓 ביטול נעילה' : '🔒 נעילה', 'נעילת טקסט המכתב במכשיר זה – פתיחה בטביעת אצבע', () => toggleLetterLock(entry));
      body.push(row);
    }
  }
  const node = el('div', { className: `msg ${mine ? 'me' : 'them other'}${entry.kind && open ? ` ${entry.kind}-msg` : ''}` }, tools,
    !mine && el('div', { className: 'sender', textContent: `✉️ מכתב של ${who}` }),
    ...body, !(entry.kind === 'voice' && open) && time(entry.ts));
  if (isShared(conv)) swipeToReply(node, { kind: 'entry', id: entry.id, name: who, text: entry.qLocked ? 'מכתב נעול' : entry.q.slice(0, 80) });
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

/** A small book whose pages turn, shown while the answer is on its way. */
function bookAnimation() {
  const box = el('span', { className: 'book-anim' });
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = '<svg viewBox="0 0 48 32" width="44" height="30"><path class="cover" d="M24 6 C18 2 8 2 3 4 V28 C8 26 18 26 24 30 C30 26 40 26 45 28 V4 C40 2 30 2 24 6 Z"/>'
    + '<path class="pg" d="M24 7 C30 3 38 3 43 5 V27 C38 25 30 25 24 29 Z"/><path class="pg p2" d="M24 7 C30 3 38 3 43 5 V27 C38 25 30 25 24 29 Z"/>'
    + '<path class="pg p3" d="M24 7 C30 3 38 3 43 5 V27 C38 25 30 25 24 29 Z"/></svg>';
  return box;
}

function entryNodes(entry, conv = convById(entry.conv)) {
  const nodes = [questionBubble(entry, conv)];
  if (entry.a && entry.collapsed) {
    const chip = el('button', { type: 'button', className: `msg them collapsed-a${isUnread(entry) ? ' unread' : ''}` },
      el('span', { className: 'ca-icon', textContent: isUnread(entry) ? '●' : '✉️' }),
      el('span', { className: 'ca-title', textContent: `${entry.a.title}${entry.fav ? ' ★' : ''}` }),
      el('span', { className: 'ca-open chev', textContent: '▾' }));
    chip.title = isUnread(entry) ? 'מענה חדש – לחצו לקריאה' : 'הרחבת המענה';
    chip.addEventListener('click', () => expandEntry(entry));
    selectable(chip, 'e', entry.id);
    if (entry.fav?.tags.length) { // the chosen tags stay in sight, under the minimized row
      const line = el('button', { type: 'button', className: 'fav-line', textContent: `★ ${entry.fav.tags.join(' · ')}`, title: 'הרחבת המענה והתגיות' });
      line.addEventListener('click', () => { entry.tagsOpen = true; expandEntry(entry); });
      nodes.push(el('div', { className: 'ca-wrap' }, chip, el('div', { className: 'fav-under' }, line)));
    } else nodes.push(chip);
  } else if (entry.a) {
    const bubble = answerBubble(entry);
    if (isShared(conv)) swipeToReply(bubble, { kind: 'answer', id: entry.id, name: 'המענה', text: entry.a.title });
    nodes.push(selectable(bubble, 'e', entry.id));
  } else if (entry.pending && entry.kind === 'photo') { /* the progress is inside the photo's own bubble */
  } else if (entry.pending) {
    nodes.push(el('div', { className: 'msg them typing' },
      el('div', { className: 'opening' }, bookAnimation(), el('span', { textContent: entry.kind === 'photo' ? 'מזהים את האגרת בצילום ומביאים אותה מהמאגר…' : 'פותחים את אגרות הקודש…' })),
      el('div', { className: 'note', textContent: 'אפשר לצאת מהשיחה ולחזור אחר כך – נודיע כשהמענה יהיה מוכן.' })));
  }
  else if (entry.draft) { /* waiting for the user: approve or delete, in the bubble itself */ }
  else nodes.push(selectable(errorBubble(entry), 'e', entry.id));
  return nodes;
}

/** No answer: the reason, and – for a photo – deleting it and choosing another (or trying again when it may help). */
const PHOTO_FINAL = new Set(['PHOTO_BAD', 'PHOTO_NOT_IGROT', 'PHOTO_UNREADABLE', 'PHOTO_NOT_FOUND', 'PHOTO_GONE']);
function errorBubble(entry) {
  const box = el('div', { className: 'msg them error' }, el('div', { textContent: entry.error || 'לא התקבל מענה למכתב זה.' }));
  if (entry.kind === 'photo' && isOwner(convById(entry.conv))) {
    const actions = el('div', { className: 'draft-actions' });
    if (!PHOTO_FINAL.has(entry.errorCode)) {
      const again = el('button', { type: 'button', className: 'ok', textContent: '↻ נסו שוב' });
      again.addEventListener('click', () => sendDraft(entry));
      actions.append(again);
    }
    const redo = el('button', { type: 'button', className: 'del', textContent: '🗑 מחיקה וטעינה מחדש' });
    redo.addEventListener('click', () => { removeEntry(entry); choosePhotoAgain($('camera')); });
    actions.append(redo);
    box.append(actions);
  }
  return box;
}

// views: list (all chats) | archive | locked | fav | chat (one conversation)
let view = { name: 'list' };
let search = '';
let searchDate = ''; // 'YYYY-MM-DD': chats / letters of that day
let searchOpen = false; // the search bar inside a chat (opened from the ⋮ menu)
let tagFilter = ''; // in a chat: '' = everything, '*' = all favourites, or one tag

// ---------- read / unread (kept on this device) ----------
// An answer is unread until it is opened; messages from others are unread until the chat is opened.
const isUnread = (e) => !!e.a && !!e.unread;
function unreadCount(conv) {
  const answers = entriesOf(conv.id).filter(isUnread).length;
  const msgs = messagesOf(conv.id).filter((m) => (!user || m.uid !== user.uid) && conv.readTs && m.ts > conv.readTs).length;
  return answers + msgs;
}
function setRead(entry, read = true) {
  if (read) delete entry.unread; else entry.unread = true;
}
/** Minimizes an answer – and every section inside it, so it opens again the way it was first shown. */
function collapseEntry(entry) {
  entry.collapsed = true;
  delete entry.qOpen;
  for (const k of ['showMore', 'analysisOpen', 'translationOpen', 'followupsOpen', 'textOpen', 'tagsOpen', 'analysisClosed', 'followupsClosed']) delete entry[k];
}
function expandEntry(entry) {
  entry.collapsed = false;
  setRead(entry);
  save(); render();
}

function go(next) {
  if (next.name === 'chat') {
    const conv = convById(next.id);
    // a chat always opens with its letters and answers minimized
    for (const e of entriesOf(next.id)) if (e.a) collapseEntry(e);
    if (conv) { conv.readTs = Date.now(); delete conv.markedUnread; }
    save();
  }
  if (next.name !== 'chat' || next.id !== view.id) tagFilter = '';
  view = next;
  search = ''; searchDate = ''; searchOpen = false;
  $('search').value = '';
  for (const e of state.entries) if (e.qLocked) delete e.qOpen; // locked letters close when leaving
  unlockedQ.clear();
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

// ---------- the size of the app's own text (buttons, menus, titles): regular / large / very large ----------
const UI_SIZES = ['', 'large', 'xlarge'];
let uiSize = '';
try { uiSize = localStorage.getItem('mlr-ui-size') || ''; } catch { /* ignore */ }
function setUiSize(v) {
  uiSize = UI_SIZES.includes(v) ? v : '';
  if (uiSize) document.documentElement.dataset.ui = uiSize; else delete document.documentElement.dataset.ui;
  try { localStorage.setItem('mlr-ui-size', uiSize); } catch { /* ignore */ }
  for (const b of document.querySelectorAll('.seg-btn')) b.setAttribute('aria-checked', String(b.dataset.ui === uiSize));
}
setUiSize(uiSize);
for (const b of document.querySelectorAll('.seg-btn')) b.addEventListener('click', () => setUiSize(b.dataset.ui));
/** The settings dialog: on the web only the text size; in the Android app also the server and updates. */
function openSettings() {
  if (nativeSettings) { nativeSettings(); return; }
  $('update-section').hidden = true;
  $('server-section').hidden = true;
  $('settings').showModal();
}

// ---- conversation actions (the ⋮ of a chat, or a selected chat in the list) ----
function convMenuItems(conv) {
  const owner = isOwner(conv);
  const people = isShared(conv) ? (conv.members || []).map((u) => nameOf(conv, u) + (u === conv.owner ? ' (פותח השיחה)' : '')).join(', ') : '';
  const answered = entriesOf(conv.id).filter((e) => e.a);
  const allCollapsed = answered.length && answered.every((e) => e.collapsed);
  return [
    people && { info: `👥 ${people}` },
    { label: '🔍 חיפוש בשיחה', onClick: () => { if (view.id !== conv.id) go({ name: 'chat', id: conv.id }); openChatSearch(); } },
    answered.length && { label: allCollapsed ? '▾ הרחבת כל ההתכתבויות' : '▴ מזעור כל ההתכתבויות', onClick: () => collapseAll(conv, !allCollapsed) },
    entriesOf(conv.id).some((e) => e.fav) && { label: '🏷 סינון לפי תגיות', onClick: () => { tagFilter = tagFilter || '*'; if (view.id !== conv.id) go({ name: 'chat', id: conv.id }); else render(); } },
    owner && { label: '✎ שינוי שם', onClick: () => renameConv(conv) },
    owner && { label: '👥 שיתוף עם אנשי קשר', onClick: () => shareConv(conv) },
    owner && { label: '🔗 העתקת קישור לשיחה', onClick: () => copyConvLink(conv) },
    owner && (isShared(conv) || conv.inviteToken) && { label: '✋ הפסקת השיתוף', onClick: () => stopSharingConv(conv) },
    { label: conv.archived ? '📤 הוצאה מהארכיון' : '🗄 העברה לארכיון', onClick: () => toggleArchive([conv]) },
    { label: conv.locked ? '🔓 ביטול נעילה' : '🔒 נעילת השיחה (במכשיר זה)', onClick: () => toggleLock([conv]) },
    { label: !conv.cloud ? '🗑 גניזת השיחה' : owner ? '🗑 גניזת השיחה לכולם' : '🚪 יציאה מהשיחה', danger: true, onClick: () => deleteConvs([conv]) },
  ];
}
function homeMenuItems() {
  return [
    { label: user ? `👤 ${user.displayName || user.email}` : '👤 התחברות עם Google', onClick: openAccount },
    { label: isNativeApp ? '⚙ הגדרות ועדכונים' : '⚙ הגדרות', onClick: openSettings },
  ];
}

/** Minimizes (or expands) every letter-and-answer of a conversation; kept on this device. */
function collapseAll(conv, on) {
  for (const e of entriesOf(conv.id)) if (e.a) { if (on) collapseEntry(e); else { delete e.collapsed; setRead(e); } }
  save(); render();
}
function paintCollapseAll(conv) {
  const answered = conv ? entriesOf(conv.id).filter((e) => e.a) : [];
  const all = answered.length && answered.every((e) => e.collapsed);
  const b = $('collapse-all');
  b.hidden = !answered.length;
  b.textContent = all ? '⊞' : '⊟';
  b.title = all ? 'הרחבת כל ההתכתבויות' : 'מזעור כל ההתכתבויות';
  b.setAttribute('aria-label', b.title);
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
let toastAction = null;
function toast(text, action = null) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  toastAction = action;
  t.classList.toggle('action', !!action);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; toastAction = null; }, action ? 6000 : 2200);
}
$('toast').addEventListener('click', () => { const fn = toastAction; $('toast').hidden = true; toastAction = null; fn?.(); });

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
    ? (!one.cloud ? `לגנוז את השיחה "${one.title}"? היא תימחק מהמכשיר.`
      : owner(one) ? `לגנוז את השיחה "${one.title}"? היא תימחק לכל המשתתפים ומכל המכשירים.` : `לצאת מהשיחה "${one.title}"?`)
    : `לגנוז ${convs.length} שיחות? הן יימחקו, ושיחות שנשמרו בחשבון יימחקו לכל המשתתפים.`;
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
  const fire = (byTouch) => {
    if (Date.now() - longPressAt < 400) return; // the same press, reported twice (timer + contextmenu)
    longPressAt = Date.now();
    fired = byTouch; // a touch press is followed by a click that must be ignored; a right click is not
    fn();
  };
  node.addEventListener('contextmenu', (e) => { if (e.target.closest?.('textarea, input')) return; e.preventDefault(); fire(false); });
  node.addEventListener('touchstart', (e) => {
    fired = false;
    clearTimeout(timer);
    if (e.touches.length !== 1 || e.target.closest?.('.hl, textarea, input, select')) return;
    timer = setTimeout(() => fire(true), 500);
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
  const hit = search ? searchHit(conv) : null; // while searching, the row shows where the text was found
  const favs = entries.filter((e) => e.fav).length;
  const unread = unreadCount(conv);
  const waiting = entries.some((e) => e.pending);
  const row = el('button', { type: 'button', className: `conv${waiting ? ' waiting' : ''}${unread || conv.markedUnread ? ' has-unread' : ''}` },
    el('span', { className: 'conv-avatar' }, conv.locked ? '🔒' : isShared(conv) ? '👥' : '✉️', waiting && el('span', { className: 'conv-spin', title: 'ממתין למענה' })),
    el('span', { className: 'conv-main' },
      el('span', { className: 'conv-top' },
        el('b', { className: 'conv-title', textContent: conv.title }),
        el('span', { className: 'conv-time', textContent: shortTime(lastTs(conv)) })),
      el('span', { className: 'conv-bottom' },
        el('span', { className: 'conv-preview', textContent: hit?.text ? `🔍 ${hit.label ? `${hit.label} ` : ''}${hit.text}` : preview }),
        waiting ? el('span', { className: 'conv-wait', textContent: '⏳ מענה בדרך' }) : null,
        favs ? el('span', { className: 'conv-badge', textContent: `★ ${favs}` }) : null,
        unread ? el('span', { className: 'conv-count', textContent: String(unread), title: 'לא נקראו' })
          : conv.markedUnread ? el('span', { className: 'conv-count dot', title: 'סומן כלא נקרא' }) : null)));
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

// ---------- search: titles, letters, the answer page's text, the analysis, translation and follow-ups, chat messages ----------
/** Lower case, no niqqud / cantillation, no quote marks or geresh, single spaces – so "שליט\"א" finds שליטא and vowelled text matches plain. */
const normSearch = (t) => String(t || '').toLowerCase()
  .replace(/[\u0591-\u05C7]/g, '').replace(/["'`״׳“”„‘’]/g, '').replace(/\s+/g, ' ');

/** The searchable parts of an entry, each with a label for the result line. */
function entryParts(e) {
  const a = e.a || {};
  return [
    ...(e.qLocked ? [] : [['', e.q], ['', e.note], ['', e.sum]]), // a locked letter is not found by its text
    ['✉️', [a.title, a.volumeHeading, ...(a.letters || []).flatMap((l) => [l.number, l.pageText])].filter(Boolean).join(' · ')],
    ['💡', a.explanation],
    ['🌐', a.translation],
    ['❝', a.keyQuote],
    ...(e.followups || []).flatMap((f) => [['❓', f.q], ['💬', f.a]]),
  ].filter(([, t]) => t);
}

/** A short excerpt of `text` around the first hit of the (normalized) query, or null. */
function searchSnippet(text, q) {
  const words = String(text).replace(/\s+/g, ' ');
  // normalize character by character, remembering where each normalized character came from
  let norm = '';
  const from = [];
  for (let i = 0; i < words.length; i += 1) {
    const c = normSearch(words[i]);
    norm += c;
    for (let k = 0; k < c.length; k += 1) from.push(i);
  }
  const at = norm.indexOf(q);
  if (at < 0) return null;
  const start = Math.max(0, from[at] - 30);
  const end = (from[at + q.length - 1] ?? words.length) + 60;
  return `${start ? '…' : ''}${words.slice(start, end).trim()}${end < words.length ? '…' : ''}`;
}

/** The first place `conv` matches the search: { label, text } (text = excerpt), or null. */
function searchHit(conv) {
  const q = normSearch(search).trim();
  if (!q) return null;
  if (normSearch(conv.title).includes(q)) return { label: '', text: null };
  for (const e of entriesOf(conv.id)) {
    for (const [label, text] of entryParts(e)) {
      if (normSearch(text).includes(q)) return { label, text: searchSnippet(text, q) };
    }
  }
  for (const m of messagesOf(conv.id)) {
    if (normSearch(m.text).includes(q)) return { label: `${m.name}:`, text: searchSnippet(m.text, q) };
  }
  return null;
}

const onDay = (conv, day) => entriesOf(conv.id).some((e) => dayKey(e.ts) === day) || messagesOf(conv.id).some((m) => dayKey(m.ts) === day);
const matches = (conv) => (!search || !!searchHit(conv)) && (!searchDate || onDay(conv, searchDate));

function renderConvList(which) {
  const list = state.convs
    .filter((c) => (which === 'locked' ? c.locked : !c.locked && (which === 'archive' ? c.archived : !c.archived)))
    .filter(matches)
    .sort((a, b) => lastTs(b) - lastTs(a));

  const box = el('div', { className: 'conv-list' });
  if (which === 'list' && !search && !searchDate) {
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
    box.append(el('div', { className: 'empty', textContent: search || searchDate ? 'לא נמצאו שיחות.'
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

/** The tags of a chat as filter chips: everything, all favourites, or one tag. */
function tagFilterBar(conv) {
  const favs = entriesOf(conv.id).filter((e) => e.fav);
  const counts = new Map();
  for (const e of favs) for (const t of e.fav.tags) counts.set(t, (counts.get(t) || 0) + 1);
  const bar = el('div', { className: 'tag-filter' });
  const chip = (value, label) => {
    const b = el('button', { type: 'button', className: `chip${tagFilter === value ? ' on' : ''}`, textContent: label });
    b.addEventListener('click', () => { tagFilter = value; render(); });
    return b;
  };
  const close = el('button', { type: 'button', className: 'chip close', textContent: '✕', title: 'סגירת הסינון' });
  close.addEventListener('click', () => { tagFilter = ''; render(); });
  bar.append(el('span', { className: 'tf-label', textContent: '🏷' }), chip('*', `★ כל המועדפים (${favs.length})`),
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([t, n]) => chip(t, `${t} (${n})`)), close);
  return bar;
}

function renderChat(conv) {
  const box = el('div', { className: 'chat-body' });
  let lastDay = null;
  const passes = (e) => !tagFilter || (e.fav && (tagFilter === '*' || e.fav.tags.includes(tagFilter)));
  // search inside the chat: by text (letters, answers, analysis, messages) and / or by day
  const sq = normSearch(search).trim();
  const filtering = !!(sq || searchDate);
  const found = (ts, texts) => (!searchDate || dayKey(ts) === searchDate) && (!sq || texts.some((t) => normSearch(t).includes(sq)));
  const items = [...entriesOf(conv.id).filter(passes).filter((e) => !filtering || found(e.ts, entryParts(e).map(([, t]) => t))).map((e) => ({ ts: e.ts, e })),
    ...(tagFilter ? [] : messagesOf(conv.id).filter((m) => !filtering || found(m.ts, [m.text])).map((m) => ({ ts: m.ts, m })))]
    .sort((x, y) => x.ts - y.ts);
  if (filtering) box.append(el('div', { className: 'empty', textContent: items.length ? `נמצאו ${items.length} פריטים` : 'לא נמצא דבר בשיחה.' }));
  if (tagFilter) {
    box.append(tagFilterBar(conv));
    if (!items.length) box.append(el('div', { className: 'empty', textContent: 'אין בשיחה מענים עם התגית הזו.' }));
  }
  if (!items.length && !tagFilter && !filtering) {
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
  $('camera').hidden = $('attach').hidden = !toRebbe; // a photo or a recording is a letter to the Rebbe
  paintSend();
}
$('mode').addEventListener('click', () => { toRebbe = !toRebbe; paintComposer(convById(view.id)); input.focus(); paintOpeners(); });

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
  $('search-bar').hidden = !(inList || (conv && searchOpen));
  paintSearchBar();
  $('new-chat').hidden = view.name !== 'list';
  form.hidden = !conv;
  if (rec.active && rec.conv !== conv?.id) stopRecording(true);
  if (conv) paintComposer(conv);
  paintCollapseAll(conv);

  const focused = chat.contains(document.activeElement) && document.activeElement.dataset.fid ? document.activeElement : null;
  const fid = focused?.dataset.fid;
  const caret = focused ? [focused.selectionStart, focused.selectionEnd] : null;
  const keepScroll = !scroll && chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80; // stay at the bottom
  const top = chat.scrollTop;
  chat.textContent = '';
  if (inList) chat.append(renderConvList(view.name));
  else if (view.name === 'fav') chat.append(renderFav());
  else chat.append(renderChat(conv));
  if (scroll || (conv && keepScroll)) scrollDown(); else chat.scrollTop = top;
  if (fid) { // the box the user was typing in was rebuilt: the typing goes on (a note becomes part of the draft text)
    const again = chat.querySelector(`[data-fid="${fid}"]`) || chat.querySelector(`[data-fid="${fid.replace(/^note:/, 'draft:')}"]`);
    if (again) { again.focus({ preventScroll: true }); try { again.setSelectionRange(caret[0], caret[1]); } catch { /* not a text box */ } }
  }
  paintSelection();
}

$('back').addEventListener('click', () => go({ name: view.name === 'chat' && convById(view.id)?.archived ? 'archive'
  : view.name === 'chat' && convById(view.id)?.locked ? 'locked' : 'list' }));
$('chat-menu').addEventListener('click', (e) => { const c = convById(view.id); if (c) showMenu(e.currentTarget, convMenuItems(c)); });
$('home-menu').addEventListener('click', (e) => showMenu(e.currentTarget, homeMenuItems()));
$('collapse-all').addEventListener('click', () => {
  const c = convById(view.id);
  if (c) collapseAll(c, !entriesOf(c.id).filter((e) => e.a).every((e) => e.collapsed));
});
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
const repaintSearch = () => {
  const conv = view.name === 'chat' ? convById(view.id) : null;
  chat.textContent = '';
  chat.append(conv ? renderChat(conv) : renderConvList(view.name));
  paintSearchBar();
};
$('search').addEventListener('input', (e) => { search = e.target.value.trim(); repaintSearch(); });
function paintSearchBar() {
  const inChat = view.name === 'chat';
  $('search-close').hidden = !inChat;
  $('search-glass').hidden = inChat;
  $('search').placeholder = inChat ? 'חיפוש בשיחה…' : 'חיפוש…';
  $('search-date').classList.toggle('on', !!searchDate);
  $('search-date-chip').hidden = !searchDate;
  if (searchDate) $('search-date-chip').textContent = `📅 ${dayLabel(searchDate)} ✕`;
}
// by date: the calendar button opens the device's date picker
$('search-date').addEventListener('click', () => {
  const d = $('search-date-input');
  d.value = searchDate;
  try { d.showPicker(); } catch { d.focus(); d.click(); }
});
$('search-date-input').addEventListener('change', (e) => { searchDate = e.target.value || ''; repaintSearch(); });
$('search-date-chip').addEventListener('click', () => { searchDate = ''; repaintSearch(); });
function closeChatSearch() { search = ''; searchDate = ''; searchOpen = false; $('search').value = ''; render(); }
$('search-close').addEventListener('click', closeChatSearch);
function openChatSearch() { searchOpen = true; render(); $('search').focus(); }

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
    conv.title = conv.autoTitle = text.split(/\s+/).slice(0, 5).join(' ').slice(0, 40); // until the AI names the chat by its subject
    if (conv.cloud) cloud.renameConv(conv.id, conv.title).catch(() => {});
  }
  const entry = { id: newId(), conv: conv.id, q: text, ts: Date.now(), pending: true, lang: replyLang || undefined };
  summarizeEntry(entry);
  if (replyTo) { entry.replyTo = replyTo; setReply(null); }
  state.entries.push(entry);
  save();
  render({ scroll: true });
  askNotifyPermission();
  requestAnswer(entry);
}

// ---------- the answer is fetched in the background: the user can leave and come back ----------
const inFlight = new Set(); // entry ids being answered now
async function requestAnswer(entry) {
  if (inFlight.has(entry.id)) return;
  inFlight.add(entry.id);
  let tries = 0;
  const isPhoto = entry.kind === 'photo';
  let body = { letter: entry.q, replyLanguage: entry.lang || undefined };
  if (isPhoto) { // the photo goes to the server; only its numbers are read there
    const blob = await media.get(imgKey(entry));
    body = blob && { image: await blobToBase64(blob), mimeType: blob.type || 'image/jpeg' };
    if (!body) { entry.error = 'הצילום אינו שמור עוד במכשיר. מחקו וטענו אותו שוב.'; entry.errorCode = 'PHOTO_GONE'; }
  }
  while (body) {
    try {
      const res = await fetch(`${API}${isPhoto ? '/api/photo' : '/api/letters'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        entry.a = data;
        SOUND.answer();
        delete entry.error; delete entry.errorCode;
        if (isPhoto) entry.q = photoCaption(data);
      } else { entry.error = data.message || 'אירעה שגיאה. נסו שוב.'; entry.errorCode = data.error; }
      break;
    } catch {
      // no connection (or the free server is waking up): try again for a few minutes before giving up
      if (++tries > 6) { entry.error = 'אין חיבור לשרת. בדקו את החיבור ונסו שוב.'; break; }
      await new Promise((r) => setTimeout(r, Math.min(30000, 3000 * 2 ** tries)));
    }
  }
  inFlight.delete(entry.id);
  if (!state.entries.includes(entry)) return; // deleted meanwhile
  delete entry.pending;
  const conv = convById(entry.conv);
  if (isPhoto && entry.a && conv?.title === 'שיחה חדשה') {
    conv.title = entry.q.replace(`${PHOTO_Q} – `, '📷 ').slice(0, 40);
    if (conv.cloud) cloud.renameConv(conv.id, conv.title).catch(() => {});
  }
  const watching = view.name === 'chat' && view.id === entry.conv && !document.hidden;
  if (entry.a) {
    if (watching) entry.collapsed = false; // just arrived in front of the user: shown open, and read
    else { entry.unread = true; collapseEntry(entry); notifyReady(conv, entry); }
  }
  save();
  if (watching) render({ scroll: true }); else render();
  if (conv?.cloud && user) cloud.saveEntry(conv.id, entry).catch((e) => console.warn('entry not synced', e));
}

/** What was read off the photo: "צילום עמוד מאגרות קודש – כרך יג, עמוד קמב, אגרת ד'תצא". */
function photoCaption(a) {
  const p = a.photo || {};
  const where = [a.volumeHeading, p.page && `עמוד ${p.page}`, p.letters?.length && `${p.letters.length > 1 ? 'אגרות' : 'אגרת'} ${p.letters.join(', ')}`].filter(Boolean);
  return `${PHOTO_Q} – ${where.join(', ')}`;
}

/** Asks once for permission to notify when an answer is ready. */
let notifyAsked = false;
async function askNotifyPermission() {
  if (notifyAsked) return;
  notifyAsked = true;
  try {
    if (isNativeApp) await window.Capacitor.registerPlugin('LocalNotifications').requestPermissions();
    else if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  } catch { /* no notifications: the toast and the mark on the chat remain */ }
}
async function notifyReady(conv, entry) {
  const title = '✉️ המענה מוכן';
  const body = `${conv?.title || 'מכתבים לרבי'} – ${entry.a.title}`;
  toast(`✉️ המענה מוכן ב"${conv?.title || ''}" – לחצו לפתיחה`, () => go({ name: 'chat', id: entry.conv }));
  if (!document.hidden && !isNativeApp) return; // in front of the user: the toast is enough
  try {
    if (isNativeApp) {
      await window.Capacitor.registerPlugin('LocalNotifications').schedule({
        notifications: [{ id: Math.floor(Math.random() * 2e9), title, body, extra: { conv: entry.conv } }],
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) await reg.showNotification(title, { body, icon: 'icon.svg', tag: entry.id, data: { conv: entry.conv } });
      else new Notification(title, { body, icon: 'icon.svg' });
    }
  } catch (e) { console.warn('notification', e); }
}
// a tap on a notification opens the conversation
navigator.serviceWorker?.addEventListener?.('message', (e) => { if (e.data?.openConv && convById(e.data.openConv)) go({ name: 'chat', id: e.data.openConv }); });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (skipSubmit) { skipSubmit = false; return; } // the end of a hold on the microphone
  if (rec.active) { stopRecording(); return; } // ✓ ends a locked recording; it then waits in the chat for approval
  const text = input.value.trim();
  if (!text) { if (toRebbe) startRecording(true); return; } // from the keyboard: a locked recording
  input.value = ''; input.style.height = '';
  paintSend();
  submit(text);
});
const growInput = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
input.addEventListener('input', () => { growInput(); paintOpeners(); paintSend(); });
input.addEventListener('focus', () => { paintOpeners(); setTimeout(() => { growInput(); scrollDown(); }, 300); }); // after the keyboard opens
input.addEventListener('blur', () => { $('openers').hidden = true; });

// ---------- quick opening for a letter: offered as chips when the empty letter box gets focus ----------
const DEFAULT_OPENING = 'לכבוד הרבי מלך המשיח שליט"א';
const normOpening = (s) => s.replace(/[״"'\u05f3\u05f4]/g, '').replace(/\s+/g, ' ').replace(/[,:;!\s]+$/, '').trim();
// the openings this user writes most often: the first line of previous letters (two lines when the first is only ב"ה)
function commonOpenings() {
  const counts = new Map();
  for (const e of state.entries) {
    const lines = (e.q || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let opening = lines[0];
    if (opening.length <= 6 && lines[1]) opening = `${opening}\n${lines[1]}`;
    if (opening.length > 60 || /[.?!]$/.test(opening) || lines.length < 2 && !opening.endsWith(',')) continue; // a whole letter, not an opening
    const key = normOpening(opening);
    const c = counts.get(key) || { text: opening, n: 0 };
    c.n += 1;
    counts.set(key, c);
  }
  return [...counts.values()].filter((c) => c.n >= 2 && normOpening(c.text) !== normOpening(DEFAULT_OPENING))
    .sort((a, b) => b.n - a.n).slice(0, 2).map((c) => c.text);
}
function paintOpeners() {
  const bar = $('openers');
  const conv = view.name === 'chat' ? convById(view.id) : null;
  const show = conv && toRebbe && isOwner(conv) && document.activeElement === input && !input.value.trim();
  bar.hidden = !show;
  if (!show) return;
  bar.replaceChildren(...[...commonOpenings(), DEFAULT_OPENING].map((text) => {
    const chip = el('button', { type: 'button', className: 'opener', textContent: text.replace(/\n/g, ' · '), title: 'הוספת הפתיחה למכתב' });
    chip.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard and the focus on the letter box
    chip.addEventListener('click', () => {
      input.value = `${text}\n${input.value.replace(/^\s+/, '')}`;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      growInput();
      bar.hidden = true;
    });
    return chip;
  }));
}
if (window.visualViewport) {
  // browsers that do not resize the page for the keyboard: keep the composer above it
  visualViewport.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--vvh', `${visualViewport.height}px`);
    if (document.activeElement === input) scrollDown();
  });
}
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); if (input.value.trim()) form.requestSubmit(); }
});

// a join link opened in the browser
pendingJoin = readJoinLink(location.pathname);
if (pendingJoin) history.replaceState(null, '', '/');
// signed in before on this device: connect straight away
let signedInBefore = false;
try { signedInBefore = localStorage.getItem('mlr-signed-in') === '1'; } catch { /* ignore */ }
if (signedInBefore || state.convs.some((c) => c.cloud)) loadCloud().catch((e) => console.warn('cloud', e));
if (pendingJoin) joinNow();

{ // opened from a notification: /?conv=<id>
  const id = new URLSearchParams(location.search).get('conv');
  if (id) history.replaceState(null, '', '/');
  if (id && convById(id)) go({ name: 'chat', id }); else render();
}
for (const e of state.entries.filter((x) => x.pending && !x.a)) requestAnswer(e); // the app was closed while waiting
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

  // the server address is built into the app; the field is only shown if it is missing
  $('server-section').hidden = !!window.MLR_API_BASE;

  // a tap on an "answer ready" notification opens its chat
  try {
    Cap.registerPlugin('LocalNotifications').addListener('localNotificationActionPerformed', ({ notification }) => {
      const id = notification?.extra?.conv;
      if (id && convById(id)) go({ name: 'chat', id });
    });
  } catch { /* plugin missing in an older build */ }
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

  /**
   * The update part of the dialog shows one step at a time:
   * idle (check button) → checking → available (install button only) → downloading (progress only) → done.
   */
  let phase = 'idle';
  function paintUpdate(next, text) {
    if (next) phase = next;
    if (text !== undefined) status(text);
    const check = $('check-update'), installBtn = $('install-update'), bar = $('update-progress');
    check.hidden = !['idle', 'checking'].includes(phase);
    check.disabled = phase === 'checking';
    check.textContent = phase === 'checking' ? 'בודק…' : 'בדיקת עדכונים';
    installBtn.hidden = phase !== 'available';
    installBtn.textContent = latest ? `הורדה והתקנה של גרסה ${latest.versionName}` : 'הורדה והתקנה';
    bar.hidden = phase !== 'downloading';
    $('update-banner').hidden = phase !== 'available' || dialog.open;
  }
  const openSettings = () => {
    $('server-input').value = API;
    if (phase === 'done' && latest) paintUpdate('available', `גרסה חדשה זמינה: ${latest.versionName} (מותקנת: ${current.version || current.build}).`);
    dialog.showModal();
    paintUpdate();
  };
  nativeSettings = openSettings;
  dialog.addEventListener('close', () => paintUpdate());

  async function check({ quiet = false } = {}) {
    if (phase === 'downloading') return;
    if (!API) { if (!quiet) paintUpdate('idle', 'יש להגדיר קודם את כתובת השרת.'); return; }
    if (!quiet) paintUpdate('checking', '');
    try {
      const res = await fetch(`${API}/api/app/latest`, { cache: 'no-store' });
      const v = await res.json();
      if (!v.available) { if (!quiet) paintUpdate('idle', 'לא נמצאה גרסה בשרת.'); return; }
      if (v.versionCode > current.build) {
        latest = v;
        $('update-text').textContent = `גרסה חדשה ${v.versionName} זמינה`;
        paintUpdate('available', `גרסה חדשה זמינה: ${v.versionName} (מותקנת: ${current.version || current.build}).`);
      } else if (!quiet) {
        paintUpdate('idle', `האפליקציה מעודכנת (${current.version}).`);
      }
    } catch {
      if (!quiet) paintUpdate('idle', 'לא ניתן היה לבדוק עדכונים. בדקו את החיבור ואת כתובת השרת.');
    }
  }

  async function install() {
    if (!latest || phase === 'downloading') return;
    const { allowed } = await Updater.canInstall();
    if (!allowed) {
      paintUpdate('available', 'יש לאשר לאפליקציה להתקין עדכונים, ואז ללחוץ שוב על "הורדה והתקנה".');
      await Updater.openInstallSettings();
      return;
    }
    const bar = $('update-progress');
    bar.value = 0;
    $('update-detail').textContent = '';
    paintUpdate('downloading', 'מוריד את העדכון…');
    const sub = await Updater.addListener('progress', ({ percent }) => { bar.value = percent; status(`מוריד… ${percent}%`); });
    try {
      await Updater.downloadAndInstall({ url: `${API}${latest.downloadPath}`, expectedSize: latest.size || 0 });
      paintUpdate('done', 'ההורדה הסתיימה – אשרו את ההתקנה בחלון שנפתח.');
    } catch (e) {
      failed(DOWNLOAD_ERRORS[e?.code] || `ההורדה נכשלה (${e?.message || e}). נסו שוב.`, e?.message);
    } finally {
      sub.remove();
    }
  }

  // why an update could not be installed – the reason comes from Android itself
  const MANUAL = 'אפשר גם להתקין ידנית: "הורדה ידנית מהדפדפן" למטה.';
  const REINSTALL = 'האפליקציה המותקנת חתומה במפתח אחר מהעדכון, ולכן Android לא יעדכן אותה. יש להסיר את האפליקציה ולהתקין את הגרסה החדשה בהורדה ידנית. השיחות השמורות בחשבון Google יחזרו אחרי ההתחברות; מועדפים והדגשות שנשמרו רק במכשיר יימחקו.';
  const DOWNLOAD_ERRORS = {
    INSTALL_NOT_ALLOWED: 'יש לאשר התקנת עדכונים בהגדרות האפליקציה, ואז לנסות שוב.',
    INCOMPLETE: 'ההורדה לא הושלמה (החיבור נקטע). נסו שוב.',
    INVALID_APK: `הקובץ שהורד פגום. נסו שוב. ${MANUAL}`,
    WRONG_PACKAGE: 'הקובץ שהורד אינו של האפליקציה הזו.',
    NOT_NEWER: 'הגרסה שהורדה אינה חדשה מהמותקנת.',
    SIGNATURE_MISMATCH: REINSTALL,
  };
  function failed(text, detail) {
    paintUpdate('available', text);
    $('update-detail').textContent = detail ? `פרטים: ${detail}` : '';
    $('manual-update').hidden = false;
  }
  $('manual-update').href = 'https://github.com/yanivmalka/michtavim-larebbe/releases/latest';

  $('check-update').addEventListener('click', () => check());
  $('install-update').addEventListener('click', install);
  $('update-now').addEventListener('click', () => { openSettings(); install(); });
  paintUpdate('idle', '');

  if ($('auto-check').checked) check({ quiet: true });
}
