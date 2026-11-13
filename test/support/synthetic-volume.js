// A synthetic volume for tests: letters of Hebrew letters only, and scanned pages cut from them with OCR noise.
// Pages: page 1 is front matter (unrelated text); the pages after it are 500 characters each of the letters
// (12 pages with the default letter lengths).
import { hebrewNumeral } from '../../src/igrot/pageMap.js';

const LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת';

export function rng(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

export function hebrewText(n, rand) {
  let s = '';
  for (let i = 0; i < n; i++) s += LETTERS[Math.floor(rand() * LETTERS.length)];
  return s;
}

const noisy = (s) => [...s].map((ch, i) => (i % 17 === 16 ? (ch === 'ו' ? 'י' : 'ו') : ch)).join('');
const wrap = (s) => s.match(/.{1,60}/g).join('\n');

export function syntheticVolume({ lens = [1300, 1100, 2000, 1600] } = {}) {
  const rand = rng(7);
  const bodies = lens.map((n) => hebrewText(n, rand));
  const stream = bodies.join('');
  const pdfPages = ['שער הכרך\n' + wrap(hebrewText(400, rand))];
  for (let k = 0; k < stream.length / 500; k++) {
    const chunk = stream.slice(500 * k, 500 * k + 500);
    pdfPages.push(`${hebrewNumeral(k + 1)} אגרות קודש\n` + wrap(noisy(chunk)));
  }
  const letters = bodies.map((_, k) => [`id${k}`, `h${k}`]);
  return { bodies, letters, pdfPages, lens };
}
