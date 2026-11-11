import test from 'node:test';
import assert from 'node:assert/strict';
import { frozenPublicBrowserStartUrls } from './council-browser-scope';

test('browser start URLs come from frozen public evidence, never owner context or private library references', () => {
  const evidence = [
    { sourceName: 'SEC', sourceUrl: 'https://www.sec.gov/filing?accession=1' },
    { sourceName: 'Frozen owner context', sourceUrl: 'https://private.example.org/holdings' },
    { sourceName: 'Owner source', sourceUrl: 'https://private.example.org/document', libraryReferences: [{ sourceId: 'source', versionId: 'version' }] },
    { sourceName: 'Bad URL', sourceUrl: 'https://user:secret@bad.example.org/' },
    { sourceName: 'Local source', sourceUrl: 'file:///private.txt' },
    { sourceName: 'SEC repeated', sourceUrl: 'https://www.sec.gov/filing?accession=1' },
  ];
  assert.deepEqual(frozenPublicBrowserStartUrls(evidence as never), ['https://www.sec.gov/filing?accession=1']);
});
