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
| Page rendering | `src/render/bookPage.js` | `@napi-rs/canvas` (Skia handles RTL), font Frank Ruhl Libre (`assets/fonts`, OFL). PDFs = PNG pages via pdf-lib. `layout` also returns `boxes` (every drawn word with its offsets in the letter's page text); `GET /api/page/<spec>.png?hl=<letter id>:<start>-<end>,…` draws a marker (multiply blend) over those words – the app uses it to show the passages the explanation rests on |
| AI | `src/ai/` | `index.js` picks provider: Gemini (`gemini.js`, `@google/genai`, model fallback chain, 40 s single attempt) or Claude (`explain.js`). Endpoints `POST /api/analysis`, `/api/analysis/followup`; server rebuilds the page text from the spec. Per-IP limit `AI_RATE_PER_HOUR`. The analysis also returns `sources` (verbatim quotes the explanation rests on); `src/highlights.js` finds them in the page text (`findQuote`, punctuation-insensitive, falls back to the longest run of words) → `highlights: [{ spec, id, r: [s,e,…] }]` (flat, Firestore-safe), stored on the answer. `stripForeignScript` removes Arabic-script characters from every AI text (light Gemini models mix them in); the prompts carry the same rule (`SCRIPT_RULE`). `/api/acronyms` gets the **sentence** the word stands in (`sentence`), not the page |
| Letter-length learning | `src/igrot/lengths.js` | Records lengths of fetched letters to `LENGTHS_FILE` (lost on Render free – no disk). Meant for future length-weighted draw (not enabled) |
| App updates | `src/appUpdate.js` | Latest GitHub Release `app-v<code>`; falls back to the releases-page redirect when the API is rate-limited |
| WhatsApp | `src/whatsapp/webhook.js` | Cloud API webhook, implemented but not configured |
| Web UI | `public/app.js` (single module), `index.html`, `styles.css`, PWA `sw.js` | WhatsApp-like chats list, chats with date separators, lightbox with page turning + pinch zoom, marker (highlights), favourites+tags, archive, locked chats (fingerprint/device code), share sheet. Standard ⋮ drop-down menus (home + chat). Long press = WhatsApp-style selection (a letter and its answer are one item; delete / move to another chat / copy; chats: archive / lock / delete). Swipe a bubble sideways = reply (shared chats). One pager per answer keeps the image, the page text and the lightbox on the same page. Text size of letter/analysis by pinch or the Aa slider (`--rs`, 16px-based, independent of the app's text size); the app's own text (controls) has 3 sizes in ⚙ הגדרות (`html[data-ui]`, localStorage `mlr-ui-size`; the dialog opens on the web too). No toolbar under the answer: **selecting text** in an answer shows the tools bar (highlight, Aa, PDF, share, marker mode). "🌐 תרגם" (a select that reads as a button) sits in the answer's row next to the star; choosing a language translates an existing analysis (`POST /api/analysis/translate`). Every expand/collapse control is the same round chevron (`.chev` / `details.fold`) at the left end of its row. Minimizing an answer (`collapseEntry`) also closes every section inside it (`showMore`, `analysisOpen`, `translationOpen`, `followupsOpen`, `textOpen`, `tagsOpen` – positive flags, closed by default; opened automatically only right after the user asked for the analysis / a follow-up). Follow-up questions live **inside** the analysis section. A minimized favourite shows its tags under the row. The AI's highlights are drawn on the page image (`?hl=`) and in the page text (`mark.ai`, not removable) with a note (how many quotes were found, whether the marked letter continues on another page); on another page the note says where the marks are. Full-screen page: tap left third = next page, right third = previous, middle = zoom. A chat always opens with every answer minimized; an answer is **unread** (per device) until expanded or opened full-screen – the green number on a chat row is the unread count; selection bar marks read/unread (also whole chats). Delete is called **גניזה**. Star sits in the answer's row and opens a scrollable tags panel under it (chosen first); chat menu → filter by tags. The answer is fetched in the background (`requestAnswer`, retries, resumed after restart): the chat row shows a spinner + "מענה בדרך", and when ready a toast + notification (web: service worker `showNotification`; Android: `@capacitor/local-notifications`). Neighbouring pages are prefetched (`prefetchAround`) so turning is instant |
| Abbreviations | `public/rashei-teivot.js` | Tap on ראשי תיבות → popover from a local dictionary (~600 entries, Hebrew prefixes incl. ד, numbers/years, volume/chapter forms חי"ד ספ"ב סק"ג, words cut with a geresh שיחי' → שיחיה/שיחיו); several options are paged with → / ←; runs open together; "by context" asks the AI (`POST /api/acronyms`). `npm run abbr-stats` samples real letters and lists frequent unknown abbreviations (93% explained in Nov 2026). No free digital Chabad abbreviations book was found |
| App icon | `public/icon.svg` (single source) → `npm run icons` (`scripts/build-icons.mjs`, @napi-rs/canvas) | Crown (the Rebbe, King Moshiach) over an open Igrot Kodesh with the user's sealed letter placed in it, night-blue background. Drawn on the 108 dp adaptive canvas: `<g id="bg">` / `<g id="art">` (art inside the 66 dp safe circle). The script writes the Android launcher PNGs (foreground + legacy square/round), the splash screens and `public/icons/*.png`; the adaptive background gradient is `res/drawable/ic_launcher_background.xml`. **Commit the generated PNGs** |
| Cloud | `web/cloud.js` → bundled to `public/vendor/cloud.js` (`npm run build:web`, esbuild; **commit the bundle**) | Firebase Auth (Google) + Firestore. Loaded lazily |
| Android | `android/` (Capacitor 7), **minSdk 29 (Android 10+)**, target 35 – older phones dropped by the owner (Nov 2026) | Native plugins in `android/app/src/main/java/com/michtavim/larebbe/`: `AppUpdaterPlugin` (downloads the APK, checks size / package / newer versionCode / same signing key – the settings dialog explains each failure – then opens Android's **installer screen** (ACTION_VIEW). Kept simple on purpose: 1.0.28–1.0.30 installed through a PackageInstaller session (USER_ACTION_NOT_REQUIRED) and the owner's Galaxy A24 / Android 16 / One UI 8.5 refused them, even fresh ("App not installed", no detail); 1.0.31 (back to the installer screen) **installed only after the phone was restarted**, so the real cause may have been the phone's installer state, not the session code – unproven either way. If an install fails with no detail, first ask the owner to restart the phone. **Verified on the owner's phone (Nov 2026): the in-app update 1.0.31 → 1.0.32 installed with no restart**), `DeviceAuthPlugin` (BiometricPrompt), `MainActivity` (handles system-bar **and keyboard** insets; Capacitor's edge-to-edge is `disable`). Google sign-in via `@capacitor-firebase/authentication` (skipNativeAuth → ID token → JS SDK) |

### Data model (Firestore, project `michtavim-larebbe`, region `me-west1`)
- `convs/{id}`: `owner, title, created, lastTs, lastPreview, members[], memberInfo{uid:{name,photo}}, inviteToken`
- `convs/{id}/entries/{id}`: letters to the Rebbe + answer (`a`) + `followups[]` – **owner writes only**
- `convs/{id}/messages/{id}`: chat between participants `{uid, name, text, ts, replyTo}`
- Join link `/join/<convId>.<token>`; joining sets `joinWith` = token. Rules: `firestore.rules` (tested: `npm run test:rules`)
- `users/{uid}/private/favs` and `…/marks`: the user's own backup of favourites + tags and highlights,
  `{ items: { key: { v, ts } } }` (v = tags / flat ranges, null once removed). Merged item by item, newer `ts` wins
  (`onPrefs` / `pushPrefs` in `public/app.js`). Only that user reads/writes it (rules tested). Rules published by the
  owner and **verified on the phone (Nov 2026): favourites back up with no error**. Rules are published by hand in the
  Firebase console (no Firebase credentials here); deploying them from CI with a service-account secret was offered.
- Per-device only (localStorage `mlr-state-v4`): archived, locked, collapsed, read/unread. Not synced by design

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
- Local Android build in a cloud session: install the command-line SDK (platform 35, build-tools 35) into the scratchpad,
  write `android/local.properties` (`sdk.dir=…`, git-ignored), and pass a Gradle init script that redirects
  `repo.maven.apache.org` to `maven-central.storage-download.googleapis.com/maven2/` (Maven Central answers 429 here).
  No KVM, so no emulator: compile + `lintDebug` only.

## CI / release
**Auto-merge approved by the owner (Nov 2026):** when a requested change is done and tested, open a PR to `main`
and merge it without asking, then check that the Android build of the new version succeeded and report it.
Documentation-only changes: put `[skip ci]` in the merge commit title, so no empty app version is released.
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
- Verify with the owner: authorized domain added, authorized domain added, Android fingerprints added
  (the downloaded `google-services.json` had no Android OAuth client yet), native sign-in tested on a phone.
- Not yet verified on a real phone: keyboard insets, biometric prompt, share sheet, swipe, App Links.
- Light Gemini models sometimes mix in wrong-script characters; consider a stronger model or Claude for production.
- Length-weighted draw (data being collected), persistent disk on Render, WhatsApp setup, Play Store release build.
- Answers saved before the spec change (`/api/answers/...`) cannot be redrawn or paged.
- Pinch zoom, swipe-to-reply, long-press selection, the tools bar on text selection and the lightbox side taps were tested in headless Chromium (scratch server with fake letters + fake AI), not yet on a real phone.
- The AI highlights depend on the model quoting the page verbatim; `sourcesFound`/`sourcesTotal` show how many quotes were located.
