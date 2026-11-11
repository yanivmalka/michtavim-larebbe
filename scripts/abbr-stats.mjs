// Which abbreviations appear in the Rebbe's letters, and how many the app's dictionary explains.
// Samples letters from the chabadlibrary text API, counts ראשי תיבות (x"y) and words cut with a geresh (x'),
// and prints the most frequent ones the dictionary (public/rashei-teivot.js) does not know yet.
//   node scripts/abbr-stats.mjs [sample size, default 1500]
// In cloud sessions: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
import { loadCatalog } from '../src/igrot/catalog.js';
import { fetchLetter } from '../src/igrot/chabadlibrary.js';
import { expand } from '../public/rashei-teivot.js';

const want = Number(process.argv[2]) || 1500;
const ids = loadCatalog().flatMap((v) => v.letters.map(([id]) => id));
const step = Math.max(1, Math.floor(ids.length / want));
const sample = ids.filter((_, i) => i % step === 0);
const norm = (w) => w.replace(/[״“”]/g, '"').replace(/[׳‘’`]/g, "'");
const counts = new Map();
let failed = 0;
for (let i = 0; i < sample.length; i += 8) {
  await Promise.all(sample.slice(i, i + 8).map(async (id) => {
    try {
      const { text } = await fetchLetter(id);
      for (const raw of text.split(/[\s()[\]{},;:!?.—–-]+/)) {
        const w = norm(raw).replace(/^["']+/, '');
        if (/^[א-ת]+"[א-ת]+$/.test(w) || /^[א-ת]+'$/.test(w)) counts.set(w, (counts.get(w) || 0) + 1);
      }
    } catch { failed += 1; }
  }));
}
let total = 0; let known = 0;
const missing = [];
for (const [w, n] of counts) { total += n; if (expand(w)) known += n; else missing.push([w, n]); }
missing.sort((a, b) => b[1] - a[1]);
console.log(`letters: ${sample.length - failed} (failed ${failed}); abbreviations: ${total}; explained by the dictionary: ${(100 * known / total).toFixed(1)}%`);
console.log('most frequent unknown:', missing.slice(0, 80).map(([w, n]) => `${w} ${n}`).join(' | '));
