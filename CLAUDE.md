# מכתבים לרבי – project context

Chat app (web + Android) where a user writes a letter to the Lubavitcher Rebbe and the "book opens" at a
random page of Igrot Kodesh. The answer is an image of that page; translation (Yiddish → Hebrew/other) and an
explanation are generated **only on request**, with follow-up questions. Conversations can sync to a Google
account and be shared with contacts. UI and user-facing text are Hebrew, RTL.

The user (owner) communicates in Hebrew; reply in Hebrew. User preferences: strict conservative religious
boundaries – no content on intimate matters or matters of femininity.

## Architecture

| Part | Where | Notes |
|---|---|---|
| Server | `src/` (Node 22, Express 5, ESM) | Deployed on Render free tier: https://michtavim-larebbe.onrender.com (`render.yaml`, region Frankfurt, **no disk**) |
| Letter source | `src/igrot/chabadlibrary.js` | Text API of chabadlibrary.org: `GET /books/api/main?path=<id>`; Rebbe's Igrot = section `1200000000`, 28 volumes, 11,062 letters. In-memory cache |
| Catalog | `data/catalog.json` | All letter ids; rebuild with `npm run catalog` |
| Opening the book | `src/igrot/openBook.js` | **Simulated** page: random point in a random letter (uniform per letter), page starts up to ~1 page before it; layout decides what fits. Page = spec `[v,i,n,s]` base64url → `/api/page/<spec>.png` is redrawn on demand (survives restarts). `turnPage` gives next/prev page (prev is refined iteratively) |
| Page rendering | `src/render/bookPage.js` | `@napi-rs/canvas` (Skia handles RTL), font Frank Ruhl Libre (`assets/fonts`, OFL). PDFs = PNG pages via pdf-lib |
| AI | `src/ai/` | `index.js` picks provider: Gemini (`gemini.js`, `@google/genai`, model fallback chain, 40 s single attempt) or Claude (`explain.js`). Endpoints `POST /api/analysis`, `/api/analysis/followup`; server rebuilds the page text from the spec. Per-IP limit `AI_RATE_PER_HOUR` |
| Letter-length learning | `src/igrot/lengths.js` | Records lengths of fetched letters to `LENGTHS_FILE` (lost on Render free – no disk). Meant for future length-weighted draw (not enabled) |
| App updates | `src/appUpdate.js` | Latest GitHub Release `app-v<code>`; falls back to the releases-page redirect when the API is rate-limited |
| WhatsApp | `src/whatsapp/webhook.js` | Cloud API webhook, implemented but not configured |
| Web UI | `public/app.js` (single module), `index.html`, `styles.css`, PWA `sw.js` | WhatsApp-like chats list, chats with date separators, lightbox with page turning, marker (highlights), favourites+tags, archive, locked chats (fingerprint/device code), share sheet |
| Cloud | `web/cloud.js` → bundled to `public/vendor/cloud.js` (`npm run build:web`, esbuild; **commit the bundle**) | Firebase Auth (Google) + Firestore. Loaded lazily |
| Android | `android/` (Capacitor 7) | Native plugins in `android/app/src/main/java/com/michtavim/larebbe/`: `AppUpdaterPlugin` (download+install APK), `DeviceAuthPlugin` (BiometricPrompt), `MainActivity` (handles system-bar **and keyboard** insets; Capacitor's edge-to-edge is `disable`). Google sign-in via `@capacitor-firebase/authentication` (skipNativeAuth → ID token → JS SDK) |

### Data model (Firestore, project `michtavim-larebbe`, region `me-west1`)
- `convs/{id}`: `owner, title, created, lastTs, lastPreview, members[], memberInfo{uid:{name,photo}}, inviteToken`
- `convs/{id}/entries/{id}`: letters to the Rebbe + answer (`a`) + `followups[]` – **owner writes only**
- `convs/{id}/messages/{id}`: chat between participants `{uid, name, text, ts, replyTo}`
- Join link `/join/<convId>.<token>`; joining sets `joinWith` = token. Rules: `firestore.rules` (tested: `npm run test:rules`)
- Per-device only (localStorage `mlr-state-v4`): favourites, marks, archived, locked, collapsed. Not synced by design

## Key decisions (and why)
- **hebrewbooks.org dropped**: it serves a Cloudflare bot challenge; we do not bypass it. chabadlibrary text instead → the page layout is simulated, not the printed one (UI says so).
- **No explanation by default**: the user asked for analysis only on a one-time button press (saves free AI quota).
- **Gemini first** (user's request, free tier for development). Free-tier data may be used by Google – flagged to the user as a privacy concern for real users.
- Shared chats: contacts see letters/answers and chat/reply, but **cannot write to the Rebbe**; only the owner asks the AI.
- Locked chats are a privacy screen (not encryption).

## Commands
```bash
npm test                 # unit/integration tests (node --test)
npm run test:rules       # Firestore rules in the emulator (needs firebase-tools + Java)
npm run build:web        # rebuild public/vendor/cloud.js after editing web/cloud.js
npm run catalog          # rebuild data/catalog.json from chabadlibrary
API_BASE_URL=https://michtavim-larebbe.onrender.com npm run apk   # local debug APK (Android SDK)
```
- UI testing against emulators: set `localStorage['mlr-emulator']='1'`, then `window.__mlrSignInForTests(uid, name)`.
- In cloud sessions Node needs `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` for outbound fetch.
- Bump the `CACHE` name in `public/sw.js` when shipping UI changes.

## CI / release
`.github/workflows/android.yml`: on push to `main`, versionCode = run number; with secrets
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` it builds a
signed APK and publishes Release `app-v<n>`; repo variable `API_BASE_URL` is baked into the app.
Signing key fingerprints (registered in Firebase, served in `/.well-known/assetlinks.json`):
SHA-1 `5A:F5:D2:6B:08:C3:38:EC:2D:82:34:19:99:D3:6B:43:D2:2A:07:F3`,
SHA-256 `A1:31:8E:1B:F5:2E:7B:E3:D0:55:3D:89:33:CE:B7:9D:6A:2A:9F:A8:63:62:D0:D1:B6:DE:4E:32:B8:3F:98:BB`.
The keystore itself is **not** in git – the owner keeps it; losing it forces every user to reinstall.

## Render environment
`GEMINI_API_KEY` (set), optional `GEMINI_MODEL` / `GEMINI_MODELS`, `AI_PROVIDER`, `ANTHROPIC_API_KEY`,
`AI_RATE_PER_HOUR`, WhatsApp vars (empty). Free instance sleeps after ~15 min (first request ~1 min).

## Open items
- Verify with the owner: Firestore rules published, authorized domain added, Android fingerprints added
  (the downloaded `google-services.json` had no Android OAuth client yet), native sign-in tested on a phone.
- Not yet verified on a real phone: keyboard insets, biometric prompt, share sheet, swipe, App Links.
- Light Gemini models sometimes mix in wrong-script characters; consider a stronger model or Claude for production.
- Length-weighted draw (data being collected), persistent disk on Render, WhatsApp setup, Play Store release build.
- Answers saved before the spec change (`/api/answers/...`) cannot be redrawn or paged.
