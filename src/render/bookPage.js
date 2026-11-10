// Draws text that looks like a printed page of Igrot Kodesh, as PNG images.
// Canvas (Skia) handles right-to-left and mixed Hebrew/Latin text correctly.
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';

const font = (f) => new URL(`../../assets/fonts/${f}`, import.meta.url).pathname;
GlobalFonts.registerFromPath(font('FrankRuhlLibre_400Regular.ttf'), 'FrankRuhl');
GlobalFonts.registerFromPath(font('FrankRuhlLibre_700Bold.ttf'), 'FrankRuhlBold');

export const PAGE = { width: 1100, height: 1560, side: 96, top: 132, bottom: 110 };
const PAPER = '#fbf6ea';
const INK = '#1f1c17';
const MUTED = '#6f6758';
const RULE = '#b9ad94';

const STYLE = {
  number: { size: 34, bold: true, align: 'center', before: 18, after: 16 },
  date: { size: 26, align: 'left', after: 4, color: MUTED },
  city: { size: 26, align: 'left', after: 18, color: MUTED },
  address: { size: 30, bold: true, align: 'right', after: 16 },
  text: { size: 30, align: 'right', after: 10, indent: 30 },
  signature: { size: 30, bold: true, align: 'left', before: 6, after: 14 },
  note: { size: 22, align: 'right', after: 6, color: MUTED },
};
const LINE = 1.55;

function wrap(ctx, text, width, indent) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    let first = lines.length === 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      const limit = first ? width - indent : width;
      if (line && ctx.measureText(next).width > limit) {
        lines.push({ text: line, first });
        first = false;
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push({ text: line, first });
  }
  return lines;
}

function newCanvas(header) {
  const canvas = createCanvas(PAGE.width, PAGE.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, PAGE.width, PAGE.height);
  ctx.direction = 'rtl';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MUTED;
  ctx.font = '24px FrankRuhl';
  ctx.textAlign = 'right';
  ctx.fillText(header.right, PAGE.width - PAGE.side, 84);
  ctx.textAlign = 'left';
  ctx.fillText(header.left, PAGE.side, 84);
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAGE.side, 100);
  ctx.lineTo(PAGE.width - PAGE.side, 100);
  ctx.stroke();
  return { canvas, ctx };
}

/**
 * Lays out a flow of blocks onto pages.
 * @param {{ kind: string, text: string, letter: number, continued?: boolean }[]} flow
 *   blocks in reading order; `letter` is an index the caller uses to track what was shown.
 * @param {{ header: {right: string, left: string}, maxPages?: number, footer?: (i: number, n: number) => string }} opts
 * @returns {{ pages: Buffer[], shown: Map<number, { text: string, complete: boolean }> }}
 *   `shown` holds, per letter index, the text that made it onto the pages and whether
 *   all of that letter's blocks in the flow fit.
 */
export function layout(flow, { header, maxPages = Infinity, footer }) {
  const width = PAGE.width - PAGE.side * 2;
  const bottom = PAGE.height - PAGE.bottom;
  const pages = [];
  const shown = new Map();
  const remaining = new Map();
  for (const b of flow) remaining.set(b.letter, (remaining.get(b.letter) || 0) + 1);

  let page = newCanvas(header);
  let y = PAGE.top;
  let full = false;

  const nextPage = () => {
    pages.push(page.canvas);
    if (pages.length >= maxPages) { full = true; return false; }
    page = newCanvas(header);
    y = PAGE.top;
    return true;
  };

  for (const block of flow) {
    if (full) break;
    const s = STYLE[block.kind] || STYLE.text;
    const { ctx } = page;
    ctx.font = `${s.size}px ${s.bold ? 'FrankRuhlBold' : 'FrankRuhl'}`;
    const lh = s.size * LINE;
    const indent = block.kind === 'text' && !block.continued ? (s.indent || 0) : 0;
    const lines = wrap(ctx, block.text, width, indent);
    if (y > PAGE.top) y += s.before || 0;
    // keep a letter number together with the start of its letter (no number alone at the bottom)
    if (block.kind === 'number' && y + lh + STYLE.text.size * LINE * 4 > bottom) {
      if (!nextPage()) break;
    }

    const placed = [];
    for (const line of lines) {
      if (y + lh > bottom) {
        if (!nextPage()) break;
      }
      const c = page.ctx;
      c.font = `${s.size}px ${s.bold ? 'FrankRuhlBold' : 'FrankRuhl'}`;
      c.fillStyle = s.color || INK;
      if (s.align === 'center') {
        c.textAlign = 'center';
        c.fillText(line.text, PAGE.width / 2, y + s.size);
      } else if (s.align === 'left') {
        c.textAlign = 'left';
        c.fillText(line.text, PAGE.side, y + s.size);
      } else {
        c.textAlign = 'right';
        c.fillText(line.text, PAGE.width - PAGE.side - (line.first ? indent : 0), y + s.size);
      }
      placed.push(line.text);
      y += lh;
    }
    y += s.after || 0;

    if (placed.length) {
      const prev = shown.get(block.letter) || { text: '', complete: false, blocks: 0 };
      prev.text += (prev.text ? '\n' : '') + placed.join(' ');
      if (placed.length === lines.length) prev.blocks += 1;
      prev.complete = prev.blocks === remaining.get(block.letter);
      shown.set(block.letter, prev);
    }
  }
  if (!full) pages.push(page.canvas);

  pages.forEach((canvas, i) => {
    const text = footer?.(i, pages.length);
    if (!text) return;
    const c = canvas.getContext('2d');
    c.direction = 'rtl';
    c.font = '20px FrankRuhl';
    c.fillStyle = MUTED;
    c.textAlign = 'center';
    c.fillText(text, PAGE.width / 2, PAGE.height - 50);
  });

  return { pages: pages.map((c) => c.toBuffer('image/png')), shown };
}

/** Wraps PNG pages into a PDF (A4 width, page proportions kept). */
export async function pngsToPdf(pngs, title) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setLanguage('he');
  const w = 595.28;
  const h = w * (PAGE.height / PAGE.width);
  for (const png of pngs) {
    const img = await doc.embedPng(png);
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return Buffer.from(await doc.save());
}
