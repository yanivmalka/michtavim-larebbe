import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const file = path.join(mkdtempSync(path.join(tmpdir(), 'mlr-')), 'lengths.json');
process.env.LENGTHS_FILE = file;
const { recordLength, knownLength, lengthStats, flushLengths } = await import('../src/igrot/lengths.js');

test('letter lengths are learned, saved, and shared after a restart', () => {
  recordLength(11, [{ kind: 'text', text: 'אבגד' }, { kind: 'note', text: 'הערה' }]);
  recordLength(12, [{ kind: 'text', text: 'שלום וברכה' }]);
  assert.equal(knownLength(11), 4);
  flushLengths();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.letters['11'], { chars: 4, notes: 4 });

  // a fresh process (= server restart, or another user's request later) sees the same knowledge
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const m = await import('./src/igrot/lengths.js'); console.log(JSON.stringify(m.lengthStats(100)))"],
  { env: { ...process.env, LENGTHS_FILE: file }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { measured: 2, total: 100, coverage: 2, averageChars: 7 });
  assert.equal(lengthStats(4).coverage, 50);
});
