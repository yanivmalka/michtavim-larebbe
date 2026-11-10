// Shared, server-wide knowledge of letter lengths, learned from every letter the server
// downloads (from any user). Saved to a JSON file so it survives restarts, and meant to
// later let the draw weigh letters by length like a real book without extra downloads.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const FILE = process.env.LENGTHS_FILE || new URL('../../.cache/letter-lengths.json', import.meta.url).pathname;
const SAVE_DELAY_MS = 5000;

/** id → { chars: body characters, notes: footnote characters } */
let known = new Map();
let timer = null;
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    known = new Map(Object.entries(data.letters || {}).map(([id, v]) => [Number(id), v]));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('letter lengths: could not read', FILE, err.message);
  }
}

function save() {
  timer = null;
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), letters: Object.fromEntries(known) }));
    renameSync(tmp, FILE); // atomic: a crash never leaves a half-written file
  } catch (err) {
    console.warn('letter lengths: could not save', FILE, err.message);
  }
}

/** Records the length of a downloaded letter (no-op if already known with the same values). */
export function recordLength(id, blocks) {
  load();
  let chars = 0;
  let notes = 0;
  for (const b of blocks) {
    if (b.kind === 'note') notes += b.text.length;
    else chars += b.text.length;
  }
  const prev = known.get(id);
  if (prev && prev.chars === chars && prev.notes === notes) return;
  known.set(id, { chars, notes });
  timer ??= setTimeout(save, SAVE_DELAY_MS);
  timer.unref?.();
}

export function knownLength(id) {
  load();
  return known.get(id)?.chars;
}

/** How much of the catalog is already measured. */
export function lengthStats(totalLetters) {
  load();
  let chars = 0;
  for (const v of known.values()) chars += v.chars;
  return {
    measured: known.size,
    total: totalLetters,
    coverage: totalLetters ? Math.round((known.size / totalLetters) * 1000) / 10 : 0,
    averageChars: known.size ? Math.round(chars / known.size) : null,
  };
}

/** Writes pending changes now (used on shutdown and in tests). */
export function flushLengths() {
  if (timer) { clearTimeout(timer); save(); }
}
