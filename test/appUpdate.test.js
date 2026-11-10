import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { toVersion, latestFromRedirect } from '../src/appUpdate.js';

const release = {
  tag_name: 'app-v12', name: 'גרסה 1.0.12', body: 'תיקונים', published_at: '2026-11-10T00:00:00Z',
  assets: [{ name: 'michtavim-larebbe-1.0.12.apk', size: 4000000, url: 'https://api.github.test/a/1', browser_download_url: 'https://github.test/dl/app.apk' }],
};

test('toVersion reads app releases and ignores others', () => {
  assert.deepEqual(
    { ...toVersion(release), asset: undefined },
    { versionCode: 12, versionName: '1.0.12', notes: 'תיקונים', publishedAt: '2026-11-10T00:00:00Z', size: 4000000, asset: undefined },
  );
  assert.equal(toVersion({ ...release, tag_name: 'v2' }), null);
  assert.equal(toVersion({ ...release, assets: [] }), null);
  assert.equal(toVersion(null), null);
});

test('GET /api/app/latest and /api/app/download', async () => {
  const app = createApp({ appUpdate: { fetchRelease: async () => release } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const latest = await (await fetch(`${base}/api/app/latest`)).json();
    assert.equal(latest.available, true);
    assert.equal(latest.versionCode, 12);
    assert.equal(latest.downloadPath, '/api/app/download');
    assert.equal(latest.asset, undefined, 'internal asset URLs are not exposed');
    const dl = await fetch(`${base}/api/app/download`, { redirect: 'manual' });
    assert.equal(dl.status, 302);
    assert.equal(dl.headers.get('location'), 'https://github.test/dl/app.apk');
  } finally {
    server.close();
  }
  const none = createApp({ appUpdate: { fetchRelease: async () => null } }).listen(0);
  try {
    const r = await (await fetch(`http://127.0.0.1:${none.address().port}/api/app/latest`)).json();
    assert.deepEqual(r, { available: false });
  } finally {
    none.close();
  }
});

test('latestFromRedirect reads the version from the releases page redirect', async () => {
  const redirect = (location) => async () => new Response(null, { status: 302, headers: location ? { location } : {} });
  const v = await latestFromRedirect(redirect('https://github.com/o/r/releases/tag/app-v9'));
  assert.equal(v.versionCode, 9);
  assert.equal(v.versionName, '1.0.9');
  assert.match(v.asset.browser, /releases\/download\/app-v9\/michtavim-larebbe-1\.0\.9\.apk$/);
  assert.equal(await latestFromRedirect(redirect('https://github.com/o/r/releases')), null);
  assert.equal(await latestFromRedirect(redirect(null)), null);
});
