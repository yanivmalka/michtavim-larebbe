// The photo and the recording of a letter stay on this device (IndexedDB); nothing of them is synced.
export const media = (() => {
  const mem = new Map(); // also a fallback where IndexedDB is blocked
  let dbp = null;
  const open = () => (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('mlr-media', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('m', mode);
      const req = fn(tx.objectStore('m'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    async put(k, blob) { mem.set(k, blob); await run('readwrite', (s) => s.put(blob, k)).catch((e) => console.warn('media', e)); },
    async get(k) { return mem.get(k) || (await run('readonly', (s) => s.get(k)).catch(() => null)) || null; },
    del(k) { mem.delete(k); return run('readwrite', (s) => s.delete(k)).catch(() => {}); },
    keys: () => run('readonly', (s) => s.getAllKeys()).catch(() => []),
  };
})();
export const imgKey = (e) => `img:${e.id}`;
export const audKey = (e) => `aud:${e.id}`;
export const mediaUrls = new Map(); // key → object URL
export async function mediaUrl(key) {
  if (mediaUrls.has(key)) return mediaUrls.get(key);
  const blob = await media.get(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  mediaUrls.set(key, url);
  return url;
}
