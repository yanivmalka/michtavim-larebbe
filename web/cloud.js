// Accounts, sync and shared conversations, on Firebase (Auth + Firestore).
// Bundled to public/vendor/cloud.js by `npm run build:web` (esbuild), so the page needs no CDN.
import { initializeApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  signInWithCredential, signOut as fbSignOut,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  connectFirestoreEmulator, collection, doc, query, where, orderBy, onSnapshot, setDoc, updateDoc, deleteDoc, getDocs,
  writeBatch, arrayUnion, arrayRemove, serverTimestamp,
} from 'firebase/firestore';

let app; let auth; let db;

export function initCloud(config) {
  app = initializeApp(config);
  auth = getAuth(app);
  let cache;
  try { cache = persistentLocalCache({ tabManager: persistentMultipleTabManager() }); } catch { cache = memoryLocalCache(); }
  db = initializeFirestore(app, { localCache: cache });
  // local testing against the Firebase emulators: localStorage['mlr-emulator'] = '1'
  let emulator = false;
  try { emulator = localStorage.getItem('mlr-emulator') === '1'; } catch { /* ignore */ }
  if (emulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8085);
  }
}

/** Emulator only: sign in as a made-up Google user. */
export const signInForTests = (sub, name) => signInWithCredential(auth,
  GoogleAuthProvider.credential(JSON.stringify({ sub, email: `${sub}@example.com`, email_verified: true, name })));

export const onUser = (cb) => onAuthStateChanged(auth, cb);
export const currentUser = () => auth?.currentUser || null;

/** Web: Google popup (redirect if popups are blocked). App: pass the Google ID token from the native sign-in. */
export async function signInWithGoogle(idToken) {
  if (idToken) return signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
  const provider = new GoogleAuthProvider();
  try {
    return await signInWithPopup(auth, provider);
  } catch (e) {
    if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') return signInWithRedirect(auth, provider);
    throw e;
  }
}
export const signOut = () => fbSignOut(auth);

const me = () => {
  const u = auth.currentUser;
  if (!u) throw new Error('NOT_SIGNED_IN');
  return { uid: u.uid, name: u.displayName || u.email || 'משתמש', photo: u.photoURL || '' };
};
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const convRef = (id) => doc(db, 'convs', id);

// ---------- conversations ----------
/** Calls cb(convs) with every conversation the user belongs to, live. */
export function watchMyConvs(cb, onError) {
  const q = query(collection(db, 'convs'), where('members', 'array-contains', me().uid));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError);
}

/** Entries (letters + answers) and chat messages of one conversation, live. */
export function watchConv(id, { onEntries, onMessages, onError }) {
  const u1 = onSnapshot(query(collection(db, 'convs', id, 'entries'), orderBy('ts')), (s) => onEntries(s.docs.map((d) => ({ id: d.id, ...d.data() }))), onError);
  const u2 = onSnapshot(query(collection(db, 'convs', id, 'messages'), orderBy('ts')), (s) => onMessages(s.docs.map((d) => ({ id: d.id, ...d.data() }))), onError);
  return () => { u1(); u2(); };
}

export async function createConv({ id, title, created }) {
  const m = me();
  await setDoc(convRef(id), {
    owner: m.uid, title, created, lastTs: created, lastPreview: '',
    members: [m.uid], memberInfo: { [m.uid]: { name: m.name, photo: m.photo } },
    inviteToken: null, updated: serverTimestamp(),
  });
}

/** Uploads a whole local conversation (one batch per ~400 writes). */
export async function uploadConv(conv, entries) {
  await createConv(conv);
  for (let k = 0; k < entries.length; k += 400) {
    const batch = writeBatch(db);
    for (const e of entries.slice(k, k + 400)) batch.set(doc(db, 'convs', conv.id, 'entries', e.id), cleanEntry(e));
    await batch.commit();
  }
  const last = entries.at(-1);
  if (last) await updateDoc(convRef(conv.id), { lastTs: last.ts, lastPreview: preview(last) });
}

export const renameConv = (id, title) => updateDoc(convRef(id), { title, updated: serverTimestamp() });

/** Owner: deletes the conversation for everyone. */
export async function deleteConv(id) {
  for (const sub of ['entries', 'messages']) {
    const snap = await getDocs(collection(db, 'convs', id, sub));
    for (let k = 0; k < snap.docs.length; k += 400) {
      const batch = writeBatch(db);
      snap.docs.slice(k, k + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  await deleteDoc(convRef(id));
}

// ---------- letters to the Rebbe (owner only) ----------
const preview = (e) => (e.a ? `✉️ ${e.a.title}` : e.q).slice(0, 120);
const cleanEntry = (e) => {
  // personal flags stay on the device
  const {
    pending, fav, collapsed, showMore, textOpen, analysisOpen, translationOpen, followupsOpen, analysisClosed, followupsClosed, translating, unread, tagsOpen, lang, conv, ...rest
  } = e;
  return JSON.parse(JSON.stringify(rest));
};
export async function saveEntry(convId, entry) {
  await setDoc(doc(db, 'convs', convId, 'entries', entry.id), cleanEntry(entry));
  await updateDoc(convRef(convId), { lastTs: entry.ts, lastPreview: preview(entry) });
}
/** Owner: removes a letter and its answer (also used when moving it to another conversation). */
export const deleteEntry = (convId, id) => deleteDoc(doc(db, 'convs', convId, 'entries', id));

// ---------- chat between the participants ----------
export async function sendMessage(convId, { id, text, ts, replyTo }) {
  const m = me();
  await setDoc(doc(db, 'convs', convId, 'messages', id), { uid: m.uid, name: m.name, text, ts, replyTo: replyTo || null });
  await updateDoc(convRef(convId), { lastTs: ts, lastPreview: `${m.name}: ${text}`.slice(0, 120) });
}
export const deleteMessage = (convId, id) => deleteDoc(doc(db, 'convs', convId, 'messages', id));

// ---------- sharing ----------
/** Owner: returns the invite token, creating one if needed. */
export async function inviteToken(conv) {
  if (conv.inviteToken) return conv.inviteToken;
  const token = randomToken();
  await updateDoc(convRef(conv.id), { inviteToken: token });
  return token;
}
/** Owner: removes everyone else and invalidates the old link. */
export async function stopSharing(conv) {
  const m = me();
  await updateDoc(convRef(conv.id), { members: [m.uid], memberInfo: { [m.uid]: conv.memberInfo?.[m.uid] || { name: m.name, photo: m.photo } }, inviteToken: null });
}
export async function joinConv(id, token) {
  const m = me();
  await updateDoc(convRef(id), { members: arrayUnion(m.uid), [`memberInfo.${m.uid}`]: { name: m.name, photo: m.photo }, joinWith: token });
}
export async function leaveConv(id) {
  await updateDoc(convRef(id), { members: arrayRemove(me().uid) });
}

// ---------- the user's own backup: favourites + tags, and highlights ----------
// Two documents, users/{uid}/private/favs and …/marks, each { items: { key: { v, ts } } }.
// v = the value (tags / flat ranges), or null once removed; ts = when it was changed, so
// devices merge item by item and the newer change wins.
const privRef = (name) => doc(db, 'users', me().uid, 'private', name);
export function watchPrefs(onItems, onError) {
  const offs = ['favs', 'marks'].map((name) => onSnapshot(privRef(name),
    (s) => onItems(name, s.data()?.items || {}, s.metadata.hasPendingWrites), onError));
  return () => offs.forEach((off) => off());
}
/** Merges `items` (key → { v, ts }) into the backup. */
export const savePrefs = (name, items) => setDoc(privRef(name), { items, updated: serverTimestamp() }, { merge: true });
