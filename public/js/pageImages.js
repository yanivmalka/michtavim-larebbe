// ---------- page images: fetched whole in the background, shown only when complete, and kept on the device ----------
// The image of a page (also the one with the explanation's marks) is drawn by the server on demand. Once
// fetched it is kept in the device's cache, so the next opening shows it at once instead of drawing it again.
const PAGE_CACHE = 'mlr-pages-v1';
const PAGE_CACHE_MAX = 80;
export const pageImgs = new Map(); // url → object URL (this session)
const pageImgLoads = new Map(); // url → promise
const pageStore = () => { try { return typeof caches !== 'undefined' ? caches.open(PAGE_CACHE) : Promise.resolve(null); } catch { return Promise.resolve(null); } };
async function trimPageStore(store) {
  const keys = await store.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - PAGE_CACHE_MAX))) await store.delete(k);
}
/** Resolves, once the whole image is on the device, with a URL that shows it at once. */
export function loadPageImage(url) {
  if (pageImgs.has(url)) return Promise.resolve(pageImgs.get(url));
  if (pageImgLoads.has(url)) return pageImgLoads.get(url);
  const job = (async () => {
    let blob = null;
    const store = await pageStore().catch(() => null);
    try {
      const hit = store && await store.match(url);
      if (hit) blob = await hit.blob();
    } catch { /* read it from the server */ }
    if (!blob) {
      let res;
      try { res = await fetch(url); } catch { res = null; }
      if (res && !res.ok) throw new Error(`HTTP ${res.status}`);
      if (res) {
        if (store) store.put(url, res.clone()).then(() => trimPageStore(store)).catch(() => {});
        blob = await res.blob();
      }
    }
    if (!blob) { // fetch is not possible here: let the browser load it, and wait until it has
      await new Promise((resolve, reject) => { const im = new Image(); im.onload = resolve; im.onerror = () => reject(new Error('IMAGE')); im.src = url; });
      return url;
    }
    const local = URL.createObjectURL(blob);
    pageImgs.set(url, local);
    return local;
  })();
  pageImgLoads.set(url, job);
  job.catch(() => {}).finally(() => pageImgLoads.delete(url));
  return job;
}
