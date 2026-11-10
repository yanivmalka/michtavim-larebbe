import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { config, fill } from '../config.js';

/** Returns { pdf: Buffer, viewerUrl } for one page of a volume. */
export async function fetchPage({ volume, sourceId, page }, opts = {}) {
  const cfg = { ...config.igrot, ...opts };
  const viewerUrl = cfg.source === 'remote' ? fill(cfg.viewerUrl, { id: sourceId, page }) : null;

  if (cfg.source === 'local') {
    const file = path.join(cfg.localDir, `vol-${String(volume).padStart(2, '0')}.pdf`);
    const full = await PDFDocument.load(await readFile(file));
    const out = await PDFDocument.create();
    const [copied] = await out.copyPages(full, [page - 1]);
    out.addPage(copied);
    return { pdf: Buffer.from(await out.save()), viewerUrl };
  }

  const url = fill(cfg.pagePdfUrl, { id: sourceId, page });
  const res = await (opts.fetch || fetch)(url, { headers: { 'User-Agent': 'michtavim-larebbe/0.1' } });
  if (!res.ok) throw new Error(`SOURCE_HTTP_${res.status}`);
  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('SOURCE_NOT_PDF');
  return { pdf, viewerUrl };
}
