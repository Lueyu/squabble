'use strict';

// Check only. Creating or updating a lock requires a separately reviewed change.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, sourceTokenFingerprint } = require('./fingerprints.cjs');
try {
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, '.ui/tokens.lock.json'), 'utf8'));
  const actual = sourceTokenFingerprint();
  if (expected.hash !== actual.hash) throw new Error('Frozen token sources changed; the lock was not updated.');
  console.log('Frozen token source fingerprint matches ' + actual.hash);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
