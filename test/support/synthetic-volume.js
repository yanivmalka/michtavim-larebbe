// A synthetic volume for tests: letters of Hebrew letters only, and scanned pages cut from them with OCR noise.
// Pages: page 1 is front matter (unrelated text); pages 2..13 are 500 characters each of the letters.
const LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת';
const NUMERALS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י', 'יא', 'יב'];

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

export function syntheticVolume() {
  const rand = rng(7);
  const lens = [1300, 1100, 2000, 1600];
  const bodies = lens.map((n) => hebrewText(n, rand));
  const stream = bodies.join('');
  const pdfPages = ['שער הכרך\n' + wrap(hebrewText(400, rand))];
  for (let k = 0; k < 12; k++) {
    const chunk = stream.slice(500 * k, 500 * k + 500);
    pdfPages.push(`${NUMERALS[k]} אגרות קודש\n` + wrap(noisy(chunk)));
  }
  const letters = bodies.map((_, k) => [`id${k}`, `h${k}`]);
  return { bodies, letters, pdfPages, lens };
}
