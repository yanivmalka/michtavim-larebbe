import { newId, dayKey, dayLabel } from './util.js';

// ---------- state (kept on this device only) ----------
// convs:   conversations, like chats – { id, title, created, archived?, locked? }
// entries: one per letter written – { id, conv, q, ts, a?, fav?: { tags: [] }, collapsed? }
// marks:   highlighter ranges per text – { key: [[start, end], ...] }
const STORE = 'mlr-state-v4';
const MAX_ENTRIES = 150;
export const TAGS = ['מרגש', 'מדהים', 'מדויק', 'מחזק', 'מפתיע', 'ברכה'];

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
export const state = loadState();

/**
 * Keeps the state on the device. The state is trimmed at once; the writing itself (the whole state as one JSON
 * text – slow when there are many answers) waits a moment, so a burst of changes is written once. It is written
 * at once when the app goes to the background or closes.
 */
let saveTimer = 0;
export function save() {
  // keep favourites forever; trim the oldest of the rest
  const extra = state.entries.filter((e) => !e.fav).length - MAX_ENTRIES;
  if (extra > 0) {
    let drop = extra;
    state.entries = state.entries.filter((e) => e.fav || drop-- <= 0);
  }
  if (!saveTimer) saveTimer = setTimeout(flushSave, 250);
}
export function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer); saveTimer = 0;
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}
addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
