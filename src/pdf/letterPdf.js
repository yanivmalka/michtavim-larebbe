// Renders one letter (Hebrew / Yiddish, right-to-left) into an A4 PDF.
import { readFileSync } from 'node:fs';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();
const fontFile = (name) => readFileSync(new URL(`../../assets/fonts/${name}`, import.meta.url));
const REGULAR = fontFile('FrankRuhlLibre_400Regular.ttf');
const BOLD = fontFile('FrankRuhlLibre_700Bold.ttf');

const A4 = [595.28, 841.89];
const MARGIN = 56;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.45, 0.5);
const ACCENT = rgb(0.12, 0.23, 0.37);

/** Logical (typed) order → visual order for drawing left-to-right. */
const visual = (line) => bidi.getReorderedString(line, bidi.getEmbeddingLevels(line, 'rtl'));

// fontkit reverses any run whose script is right-to-left. So a visual line is drawn in
// segments: Hebrew-letter segments are handed over reversed (fontkit flips them back),
// everything else (digits, Latin, punctuation, spaces) is drawn as is.
const HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]+/g;
function segments(vis) {
  const out = [];
  let last = 0;
  for (const m of vis.matchAll(HEBREW)) {
    if (m.index > last) out.push(vis.slice(last, m.index));
    out.push([...m[0]].reverse().join(''));
    last = m.index + m[0].length;
  }
  if (last < vis.length) out.push(vis.slice(last));
  return out;
}
const lineWidth = (vis, font, size) => segments(vis).reduce((w, seg) => w + font.widthOfTextAtSize(seg, size), 0);
function drawVisual(page, vis, { x, y, size, font, color }) {
  for (const seg of segments(vis)) {
    page.drawText(seg, { x, y, size, font, color });
    x += font.widthOfTextAtSize(seg, size);
  }
}

function wrap(text, font, size, width) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

const STYLE = {
  date: { size: 11, bold: false, color: MUTED, align: 'left', after: 2 },
  city: { size: 11, bold: false, color: MUTED, align: 'left', after: 10 },
  address: { size: 12.5, bold: true, color: INK, align: 'right', after: 10 },
  text: { size: 12.5, bold: false, color: INK, align: 'right', after: 7 },
  signature: { size: 12.5, bold: true, color: INK, align: 'left', after: 10 },
  footnote: { size: 9.5, bold: false, color: MUTED, align: 'right', after: 4 },
};

/**
 * @param {{ blocks: {kind:string,text:string}[], volumeHeading: string, letterHeading: string,
 *           viewerUrl: string }} letter
 */
export async function renderLetterPdf(letter) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(REGULAR, { subset: true });
  const bold = await doc.embedFont(BOLD, { subset: true });
  const title = `אגרות קודש · ${letter.volumeHeading} · אגרת ${letter.letterHeading}`;
  doc.setTitle(title);
  doc.setLanguage('he');

  const width = A4[0] - MARGIN * 2;
  let page;
  let y;

  const newPage = () => {
    page = doc.addPage(A4);
    y = A4[1] - MARGIN;
    const head = visual(title);
    drawVisual(page, head, { x: A4[0] - MARGIN - lineWidth(head, bold, 10), y, size: 10, font: bold, color: ACCENT });
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: 0.6, color: ACCENT });
    y -= 26;
  };

  const draw = (text, s) => {
    const font = s.bold ? bold : regular;
    const lh = s.size * 1.55;
    for (const line of wrap(text, font, s.size, width)) {
      if (y < MARGIN + 30) newPage();
      const v = visual(line);
      const w = lineWidth(v, font, s.size);
      const x = s.align === 'left' ? MARGIN : A4[0] - MARGIN - w;
      drawVisual(page, v, { x, y, size: s.size, font, color: s.color });
      y -= lh;
    }
    y -= s.after;
  };

  newPage();
  let footnotesStarted = false;
  for (const b of letter.blocks) {
    if (b.kind === 'footnote' && !footnotesStarted) {
      footnotesStarted = true;
      y -= 6;
      page.drawLine({ start: { x: A4[0] - MARGIN - 120, y }, end: { x: A4[0] - MARGIN, y }, thickness: 0.5, color: MUTED });
      y -= 16;
    }
    draw(b.text, STYLE[b.kind] || STYLE.text);
  }

  const footer = 'מקור: ספריית ליובאוויטש';
  doc.getPages().forEach((p, i, all) => {
    const f = visual(footer);
    drawVisual(p, f, { x: A4[0] - MARGIN - lineWidth(f, regular, 8.5), y: 30, size: 8.5, font: regular, color: MUTED });
    p.drawText(letter.viewerUrl, { x: MARGIN, y: 30, size: 8.5, font: regular, color: MUTED });
    if (all.length > 1) p.drawText(`${i + 1}/${all.length}`, { x: A4[0] / 2 - 8, y: 30, size: 8.5, font: regular, color: MUTED });
  });

  return Buffer.from(await doc.save());
}
