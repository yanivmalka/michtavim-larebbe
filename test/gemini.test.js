import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFallback, modelChain } from '../src/ai/gemini.js';

const fail = (status) => Object.assign(new Error(`err ${status}`), { status });

test('busy or missing models fall through to the next one', async () => {
  const tried = [];
  const out = await withFallback(async (m) => {
    tried.push(m);
    if (m === 'a') throw fail(503);
    if (m === 'b') throw fail(429);
    return `ok:${m}`;
  }, ['a', 'b', 'c', 'd']);
  assert.equal(out, 'ok:c');
  assert.deepEqual(tried, ['a', 'b', 'c']);
});

test('a real error (bad key, bad request) stops at once', async () => {
  const tried = [];
  await assert.rejects(withFallback(async (m) => { tried.push(m); throw fail(400); }, ['a', 'b']), /err 400/);
  assert.deepEqual(tried, ['a']);
});

test('when every model is busy the last error is reported', async () => {
  await assert.rejects(withFallback(async () => { throw fail(503); }, ['a', 'b']), (e) => e.status === 503);
});

test('GEMINI_MODEL goes first, without duplicates', () => {
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';
  const chain = modelChain();
  assert.equal(chain[0], 'gemini-2.5-flash');
  assert.equal(chain.filter((m) => m === 'gemini-2.5-flash').length, 1);
  delete process.env.GEMINI_MODEL;
});
