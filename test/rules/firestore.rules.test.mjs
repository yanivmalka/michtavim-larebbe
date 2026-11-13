// Security-rule tests. Run with the Firestore emulator: npm run test:rules
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs, query, where, arrayUnion, arrayRemove } from 'firebase/firestore';

let env;
const OWNER = 'owner', FRIEND = 'friend', STRANGER = 'stranger';
const as = (uid) => env.authenticatedContext(uid).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-michtavim',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'convs/c1'), { owner: OWNER, title: 't', members: [OWNER, FRIEND], memberInfo: { [OWNER]: { name: 'o' }, [FRIEND]: { name: 'f' } }, inviteToken: 'tok', lastTs: 1 });
    await setDoc(doc(db, 'convs/c1/entries/e1'), { q: 'שאלה', ts: 1 });
    await setDoc(doc(db, 'convs/c1/messages/m1'), { uid: FRIEND, text: 'היי', ts: 2 });
  });
});

test('only participants can read a conversation and its letters', async () => {
  await assertSucceeds(getDoc(doc(as(FRIEND), 'convs/c1')));
  await assertSucceeds(getDoc(doc(as(FRIEND), 'convs/c1/entries/e1')));
  await assertFails(getDoc(doc(as(STRANGER), 'convs/c1')));
  await assertFails(getDoc(doc(as(STRANGER), 'convs/c1/entries/e1')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'convs/c1')));
  await assertSucceeds(getDocs(query(collection(as(FRIEND), 'convs'), where('members', 'array-contains', FRIEND))));
});

test('creating: only as owner and sole member, without an invite', async () => {
  await assertSucceeds(setDoc(doc(as(STRANGER), 'convs/c2'), { owner: STRANGER, members: [STRANGER], memberInfo: {}, inviteToken: null }));
  await assertFails(setDoc(doc(as(STRANGER), 'convs/c3'), { owner: OWNER, members: [STRANGER], memberInfo: {}, inviteToken: null }));
  await assertFails(setDoc(doc(as(STRANGER), 'convs/c4'), { owner: STRANGER, members: [STRANGER, FRIEND], memberInfo: {}, inviteToken: null }));
});

test('only the owner writes letters to the Rebbe', async () => {
  await assertSucceeds(setDoc(doc(as(OWNER), 'convs/c1/entries/e2'), { q: 'x', ts: 3 }));
  await assertFails(setDoc(doc(as(FRIEND), 'convs/c1/entries/e3'), { q: 'x', ts: 3 }));
  await assertFails(updateDoc(doc(as(FRIEND), 'convs/c1/entries/e1'), { q: 'שונה' }));
});

test('participants chat in their own name only', async () => {
  await assertSucceeds(setDoc(doc(as(FRIEND), 'convs/c1/messages/m2'), { uid: FRIEND, text: 'תודה', ts: 4 }));
  await assertFails(setDoc(doc(as(FRIEND), 'convs/c1/messages/m3'), { uid: OWNER, text: 'מתחזה', ts: 4 }));
  await assertFails(setDoc(doc(as(STRANGER), 'convs/c1/messages/m4'), { uid: STRANGER, text: 'x', ts: 4 }));
  await assertFails(setDoc(doc(as(FRIEND), 'convs/c1/messages/m5'), { uid: FRIEND, text: '', ts: 4 }));
  await assertSucceeds(updateDoc(doc(as(FRIEND), 'convs/c1'), { lastTs: 4, lastPreview: 'f: תודה' }));
});

test('a participant cannot take over, rename, or add others', async () => {
  await assertFails(updateDoc(doc(as(FRIEND), 'convs/c1'), { owner: FRIEND }));
  await assertFails(updateDoc(doc(as(FRIEND), 'convs/c1'), { title: 'שלי' }));
  await assertFails(updateDoc(doc(as(FRIEND), 'convs/c1'), { members: arrayUnion(STRANGER) }));
  await assertFails(updateDoc(doc(as(FRIEND), 'convs/c1'), { inviteToken: 'mine' }));
  await assertFails(updateDoc(doc(as(FRIEND), 'convs/c1'), { [`memberInfo.${OWNER}`]: { name: 'x' } }));
  await assertSucceeds(updateDoc(doc(as(FRIEND), 'convs/c1'), { [`memberInfo.${FRIEND}`]: { name: 'f2' } }));
  await assertFails(deleteDoc(doc(as(FRIEND), 'convs/c1')));
});

test('joining needs the invite token and adds only yourself; leaving works', async () => {
  const join = (token, extra = {}) => updateDoc(doc(as(STRANGER), 'convs/c1'), { members: arrayUnion(STRANGER), [`memberInfo.${STRANGER}`]: { name: 's' }, joinWith: token, ...extra });
  await assertFails(join('wrong'));
  await assertFails(join('tok', { title: 'x' }));
  await assertSucceeds(join('tok'));
  await assertSucceeds(getDoc(doc(as(STRANGER), 'convs/c1')));
  await assertSucceeds(updateDoc(doc(as(STRANGER), 'convs/c1'), { members: arrayRemove(STRANGER) }));
  await assertFails(getDoc(doc(as(STRANGER), 'convs/c1')));
});

test('no joining once sharing is stopped', async () => {
  await assertSucceeds(updateDoc(doc(as(OWNER), 'convs/c1'), { inviteToken: null, members: [OWNER] }));
  await assertFails(updateDoc(doc(as(STRANGER), 'convs/c1'), { members: arrayUnion(STRANGER), joinWith: 'tok' }));
  await assertFails(updateDoc(doc(as(STRANGER), 'convs/c1'), { members: arrayUnion(STRANGER), joinWith: null }));
});

test('the owner deletes the conversation; others delete only their own messages', async () => {
  await assertFails(deleteDoc(doc(as(STRANGER), 'convs/c1/messages/m1')));
  await assertSucceeds(deleteDoc(doc(as(FRIEND), 'convs/c1/messages/m1')));
  await assertSucceeds(deleteDoc(doc(as(OWNER), 'convs/c1')));
});

test('favourites and highlights: each user reads and writes only their own backup', async () => {
  const favs = { items: { e1: { v: ['מחזק'], ts: 5 } } };
  await assertSucceeds(setDoc(doc(as(FRIEND), 'users/friend/private/favs'), favs));
  await assertSucceeds(setDoc(doc(as(FRIEND), 'users/friend/private/marks'), { items: { 'E:e1': { v: [0, 4], ts: 6 } } }, { merge: true }));
  await assertSucceeds(getDoc(doc(as(FRIEND), 'users/friend/private/favs')));
  await assertFails(getDoc(doc(as(OWNER), 'users/friend/private/favs')));
  await assertFails(setDoc(doc(as(OWNER), 'users/friend/private/favs'), favs));
  await assertFails(setDoc(doc(as(FRIEND), 'users/friend/private/other'), favs));
  await assertFails(setDoc(doc(as(FRIEND), 'users/friend/private/favs'), { items: {}, extra: 1 }));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'users/friend/private/favs')));
});
