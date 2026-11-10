// Tells the Android app which version is the newest and serves its APK.
// Versions are GitHub Releases tagged `app-v<versionCode>` with one .apk asset
// (published by .github/workflows/android.yml).
import { Readable } from 'node:stream';
import express from 'express';

const REPO = process.env.APP_RELEASES_REPO || 'yanivmalka/michtavim-larebbe';
const TOKEN = process.env.APP_RELEASES_TOKEN; // needed only if the repository is private
const CACHE_MS = 10 * 60 * 1000;

let cached = { at: 0, value: null };

const gh = (url, accept = 'application/vnd.github+json') => fetch(url, {
  headers: {
    Accept: accept,
    'User-Agent': 'michtavim-larebbe',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  },
  redirect: 'follow',
});

/** Parses a release into what the app needs, or null if it is not an app release. */
export function toVersion(release) {
  const m = /^app-v(\d+)$/.exec(release?.tag_name || '');
  const asset = release?.assets?.find((a) => a.name.endsWith('.apk'));
  if (!m || !asset) return null;
  const versionCode = Number(m[1]);
  return {
    versionCode,
    versionName: release.name?.replace(/^[^\d]*/, '') || `1.0.${versionCode}`,
    notes: (release.body || '').slice(0, 1000),
    publishedAt: release.published_at,
    size: asset.size,
    asset: { api: asset.url, browser: asset.browser_download_url },
  };
}

export async function latestVersion({ fetchRelease } = {}) {
  if (!fetchRelease && cached.value && Date.now() - cached.at < CACHE_MS) return cached.value;
  const release = fetchRelease
    ? await fetchRelease()
    : await gh(`https://api.github.com/repos/${REPO}/releases/latest`).then((r) => (r.ok ? r.json() : null));
  const value = toVersion(release);
  if (!fetchRelease) cached = { at: Date.now(), value };
  return value;
}

export function appUpdateRouter(deps = {}) {
  const router = express.Router();

  router.get('/latest', async (_req, res) => {
    try {
      const v = await latestVersion(deps);
      if (!v) return res.json({ available: false });
      const { asset, ...info } = v;
      res.json({ available: true, ...info, downloadPath: '/api/app/download' });
    } catch (err) {
      console.error('app update check failed', err);
      res.status(502).json({ available: false, error: 'CHECK_FAILED' });
    }
  });

  router.get('/download', async (_req, res) => {
    try {
      const v = await latestVersion(deps);
      if (!v) return res.sendStatus(404);
      if (!TOKEN) return res.redirect(302, v.asset.browser); // public repository
      const r = await gh(v.asset.api, 'application/octet-stream'); // private: stream it through
      if (!r.ok || !r.body) return res.sendStatus(502);
      res.type('application/vnd.android.package-archive');
      res.set('Content-Disposition', `attachment; filename="michtavim-larebbe-${v.versionName}.apk"`);
      if (r.headers.get('content-length')) res.set('Content-Length', r.headers.get('content-length'));
      Readable.fromWeb(r.body).pipe(res);
    } catch (err) {
      console.error('app download failed', err);
      res.sendStatus(502);
    }
  });

  return router;
}
