// Draws text that looks like a printed page of Igrot Kodesh, as PNG images.
// Canvas (Skia) handles right-to-left and mixed Hebrew/Latin text correctly.
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
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

/** Breaks a block into lines; each line also lists its words (joined by single spaces in `text`). */
function wrap(ctx, text, width, indent) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    let words = [];
    let first = lines.length === 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      const limit = first ? width - indent : width;
      if (line && ctx.measureText(next).width > limit) {
        lines.push({ text: line, first, words });
        first = false;
        line = word;
        words = [word];
      } else {
        line = next;
        words.push(word);
      }
    }
    if (line) lines.push({ text: line, first, words });
  }
  return lines;
}

/**
 * Where each word of a drawn line sits on the page: boxes in page pixels, with the word's offsets
 * inside the line's text. `right` is the x of the line's right edge (text runs right to left).
 */
function wordBoxes(ctx, line, right, yTop, lh) {
  const out = [];
  let at = 0;
  for (const word of line.words) {
    const before = at ? ctx.measureText(line.text.slice(0, at)).width : 0;
    const through = ctx.measureText(line.text.slice(0, at + word.length)).width;
    out.push({ s: at, e: at + word.length, x: right - through, y: yTop, w: through - before, h: lh });
    at += word.length + 1;
  }
  return out;
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
 * @returns {{ pages: Buffer[], shown: Map<number, { text: string, complete: boolean }>,
 *   boxes: { letter: number, page: number, s: number, e: number, x: number, y: number, w: number, h: number }[] }}
 *   `shown` holds, per letter index, the text that made it onto the pages and whether
 *   all of that letter's blocks in the flow fit. `boxes` places every drawn word on its page,
 *   with its offsets (s, e) inside that letter's shown text – for highlighting on the image.
 */
export function layout(flow, { header, maxPages = Infinity, footer }) {
  const width = PAGE.width - PAGE.side * 2;
  const bottom = PAGE.height - PAGE.bottom;
  const pages = [];
  const shown = new Map();
  const boxes = [];
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
    const sofar = shown.get(block.letter)?.text.length || 0;
    let offset = sofar ? sofar + 1 : 0; // where the next line starts in the letter's shown text
    for (const line of lines) {
      if (y + lh > bottom) {
        if (!nextPage()) break;
      }
      const c = page.ctx;
      c.font = `${s.size}px ${s.bold ? 'FrankRuhlBold' : 'FrankRuhl'}`;
      c.fillStyle = s.color || INK;
      let right;
      if (s.align === 'center') {
        c.textAlign = 'center';
        c.fillText(line.text, PAGE.width / 2, y + s.size);
        right = PAGE.width / 2 + c.measureText(line.text).width / 2;
      } else if (s.align === 'left') {
        c.textAlign = 'left';
        c.fillText(line.text, PAGE.side, y + s.size);
        right = PAGE.side + c.measureText(line.text).width;
      } else {
        c.textAlign = 'right';
        right = PAGE.width - PAGE.side - (line.first ? indent : 0);
        c.fillText(line.text, right, y + s.size);
      }
      for (const b of wordBoxes(c, line, right, y, lh)) boxes.push({ letter: block.letter, page: pages.length, ...b, s: offset + b.s, e: offset + b.e });
      offset += line.text.length + 1;
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

  return { pages: pages.map((c) => c.toBuffer('image/png')), shown, boxes };
}

const MARKER = '#ffe66b';
/**
 * The page image with a marker drawn over the given word boxes (as a highlighter: the ink stays
 * dark). Words on one line are joined into one stroke.
 */
export async function drawHighlights(png, boxes) {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = MARKER;
  for (const b of mergeBoxes(boxes)) ctx.fillRect(b.x - 4, b.y + b.h * 0.12, b.w + 8, b.h * 0.84);
  return canvas.toBuffer('image/png');
}
/** Boxes on the same line that touch (or nearly) become one box. */
export function mergeBoxes(boxes) {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || b.x - a.x); // top to bottom, right to left
  const out = [];
  for (const b of sorted) {
    const last = out.at(-1);
    if (last && last.y === b.y && b.x + b.w >= last.x - 24) {
      const right = Math.max(last.x + last.w, b.x + b.w);
      last.x = Math.min(last.x, b.x);
      last.w = right - last.x;
    } else out.push({ ...b });
  }
  return out;
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
