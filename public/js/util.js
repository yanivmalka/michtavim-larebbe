// Small pure helpers: ids, day keys and labels, search normalisation, durations.
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const dayLabel = (key) => {
  if (key === dayKey(Date.now())) return 'היום';
  if (key === dayKey(Date.now() - 864e5)) return 'אתמול';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' });
};

/** Lower case, no niqqud / cantillation, no quote marks or geresh, single spaces – so "שליט\"א" finds שליטא and vowelled text matches plain. */
export const normSearch = (t) => String(t || '').toLowerCase()
  .replace(/[\u0591-\u05C7]/g, '').replace(/["'`״׳“”„‘’]/g, '').replace(/\s+/g, ' ');

export const fmtDur = (s) => { const t = Math.max(0, Math.round(s || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
