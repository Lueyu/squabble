'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { tokenDeclarations, hash } = require('./fingerprints.cjs');

test('all adjacent scoped token declarations enter the source fingerprint', () => {
  const values = tokenDeclarations(':root { --primary: red; --font-sans: Inter; --radius: 8px; }');
  assert.equal(values[0].declarations.length, 3);
  const changed = tokenDeclarations(':root { --primary: red; --font-sans: Other; --radius: 8px; }');
  assert.notEqual(hash(values), hash(changed));
});
test('layout edits do not change token hashes while theme scope and typography edits do', () => {
  const base = ':root { --primary: red; margin: 10px; font-family: Inter; }';
  assert.equal(hash(tokenDeclarations(base)), hash(tokenDeclarations(base.replace('10px', '20px'))));
  assert.notEqual(hash(tokenDeclarations(base)), hash(tokenDeclarations(base.replace(':root', '.dark'))));
  assert.notEqual(hash(tokenDeclarations(base)), hash(tokenDeclarations(base.replace('Inter', 'Other'))));
});
test('media and container thresholds are frozen even in mixed layout stylesheets', () => {
  for (const kind of ['media', 'container']) {
    const before = '@' + kind + ' (min-width:768px){:root{--primary:red;}}';
    assert.notEqual(hash(tokenDeclarations(before)), hash(tokenDeclarations(before.replace('768', '1024'))));
  }
});
