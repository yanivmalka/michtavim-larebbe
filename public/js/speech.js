// Reading a text aloud, in the voice installed on the device (the browser's speech engine; in the Android app,
// Android's text-to-speech through the Speech plugin – a WebView has no speech of its own).
// One text is read at a time; every button made by `speakButton` shows whether its text is the one being read.
import { expand, isAcronym } from '../rashei-teivot.js';
import { isYiddish } from '../lang-detect.js';

const plugin = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.registerPlugin('Speech') : null;
const synth = !plugin && 'speechSynthesis' in window ? window.speechSynthesis : null;
const LOCALES = { he: 'he-IL', yi: 'yi', en: 'en-US', ru: 'ru-RU', fr: 'fr-FR', es: 'es-ES' };
const RATE_KEY = 'mlr-speech-rate';
const RATES = { slow: 0.8, normal: 1, fast: 1.25 };

export const canSpeak = () => !!(plugin || synth);
export function speechRate() { try { return RATES[localStorage.getItem(RATE_KEY)] ? localStorage.getItem(RATE_KEY) : 'normal'; } catch { return 'normal'; } }
export function setSpeechRate(v) { try { localStorage.setItem(RATE_KEY, RATES[v] ? v : 'normal'); } catch { /* ignore */ } }

/** The language a text is written in, by its letters: Hebrew / Yiddish, Russian, or `fallback`. */
export function languageOf(text, fallback = 'en') {
  const t = String(text || '');
  const heb = (t.match(/[א-ת]/g) || []).length;
  if (heb > t.length / 4) return isYiddish(t) ? 'yi' : 'he';
  if ((t.match(/[а-яё]/gi) || []).length > t.length / 4) return 'ru';
  return fallback === 'he' || fallback === 'yi' ? 'en' : fallback;
}

/**
 * The text as it should be said: abbreviations opened by the app's dictionary (כ"ק → כבוד קדושת), so the voice
 * does not spell them; quote marks inside the words that are left are dropped, niqqud and cantillation stay.
 */
export function spoken(text, lang) {
  let t = String(text || '').replace(/\*+/g, ' ');
  if (lang !== 'he' && lang !== 'yi') return t;
  t = t.replace(/[^\s]+/g, (token) => {
    const m = /^([("'\[]*)(.*?)([)\].,;:!?]*)$/.exec(token);
    const word = m[2];
    if (!isAcronym(word)) return token;
    const first = expand(word)?.options?.[0];
    const said = first && !first.includes('–') ? first : word.replace(/["'״׳]/g, '');
    return `${m[1]}${said}${m[3]}`;
  });
  return t;
}

/** Sentences (or parts of long ones) short enough for every speech engine. */
export function chunksOf(text, max = 220) {
  const out = [];
  for (const sentence of String(text || '').split(/(?<=[.!?:;׃])\s+|\n+/)) {
    let rest = sentence.trim();
    while (rest.length > max) {
      let cut = rest.lastIndexOf(',', max);
      if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
      if (cut < 1) cut = max;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

let current = null; // { key } – what is being read now
const listeners = new Set();
export const speakingKey = () => current?.key || null;
export const onSpeechChange = (fn) => listeners.add(fn);
function setCurrent(next) {
  current = next;
  for (const fn of listeners) fn(speakingKey());
}

const fail = (code) => Object.assign(new Error(code), { code });

async function webVoices() {
  let voices = synth.getVoices();
  if (!voices.length) { // the list arrives a moment after the page
    await new Promise((resolve) => {
      const done = () => { synth.removeEventListener('voiceschanged', done); resolve(); };
      synth.addEventListener('voiceschanged', done);
      setTimeout(done, 1200);
    });
    voices = synth.getVoices();
  }
  return voices;
}
const voiceFor = (voices, lang) => {
  const code = lang === 'he' ? /^(he|iw)\b/i : new RegExp(`^${lang}\\b`, 'i');
  return voices.find((v) => code.test(v.lang) && v.localService) || voices.find((v) => code.test(v.lang)) || null;
};

async function speakWeb(job, chunks, lang) {
  const voice = voiceFor(await webVoices(), lang);
  if (!voice) throw fail(lang === 'yi' ? 'NO_YIDDISH' : 'NO_VOICE');
  synth.cancel();
  for (const chunk of chunks) {
    if (current !== job) return;
    await new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(chunk);
      u.voice = voice; u.lang = voice.lang; u.rate = RATES[speechRate()];
      u.onend = resolve;
      u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? resolve() : reject(fail('TTS_ERROR')));
      synth.speak(u);
    });
  }
}

async function speakNative(job, chunks, lang) {
  try {
    await plugin.speak({ chunks, lang: LOCALES[lang] || lang, rate: RATES[speechRate()] });
  } catch (e) {
    throw fail(e?.code === 'NO_VOICE' && lang === 'yi' ? 'NO_YIDDISH' : e?.code || 'TTS_ERROR');
  }
}

export function stopSpeaking() {
  if (!current) return;
  setCurrent(null);
  if (plugin) plugin.stop().catch(() => {}); else synth?.cancel();
}

/**
 * Reads `text` aloud (or stops, when `key` is what is being read). `lang`: 'he', 'en'… – by the text's letters
 * when not given. Rejects with code NO_VOICE / NO_YIDDISH (no such voice on the device) or TTS_ERROR.
 */
export async function toggleSpeak(key, text, lang) {
  if (current?.key === key) { stopSpeaking(); return; }
  if (!canSpeak()) throw fail('NO_TTS');
  stopSpeaking();
  const language = lang || languageOf(text, 'he');
  const chunks = chunksOf(spoken(text, language));
  if (!chunks.length) return;
  const job = { key };
  setCurrent(job);
  try {
    await (plugin ? speakNative : speakWeb)(job, chunks, language);
  } finally {
    if (current === job) setCurrent(null);
  }
}

const LABELS = ['🔊 הקראה', '⏹ עצירת ההקראה'];
function paintButton(b, key) {
  const on = b.dataset.speak === key;
  b.textContent = LABELS[on ? 1 : 0];
  b.classList.toggle('on', on);
}
onSpeechChange((key) => { for (const b of document.querySelectorAll('[data-speak]')) paintButton(b, key); });

/** A "🔊 הקראה" button for one text; `getText` is asked when it is pressed. `onError(code)` tells the user. */
export function speakButton(key, getText, lang, onError) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link-btn speak-btn';
  b.dataset.speak = key;
  paintButton(b, speakingKey());
  b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    toggleSpeak(key, getText(), lang).catch((err) => onError?.(err.code || 'TTS_ERROR'));
  });
  return b;
}
