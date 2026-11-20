const assert = require('node:assert/strict');
const { test } = require('node:test');
const fixture = require('./simple-test-loader.cjs');

function renderReport(snapshot, { simple = false, language = 'en', source = null } = {}) {
  const { load, render, state } = fixture();
  state.simpleExperience = simple;
  state.language = language;
  state.queries.set('research-document', {
    data: {
      version: {
        id: 'version-1', title: 'Saved research', kind: 'portfolio', version: 1,
        status: 'valid', sourceStatus: 'available', createdAt: '2026-11-19T12:00:00Z',
        sections: [{ id: 'summary', title: 'Summary', content: 'Saved report text.' }],
        dataAsOf: '2026-11-18T12:00:00Z', snapshot,
        source,
      },
      document: { strategyVersionIds: [] }, versions: [], drafts: [], diff: [], strategyUses: [],
    },
  });
  return render(load('pages/Analysis/ResearchDocumentPage.tsx').default);
}

function summaryText(html, heading = 'Frozen inputs') {
  const cards = html.match(/<section\b[^>]*>[\s\S]*?<\/section>/g) ?? [];
  const card = cards.find(section => section.includes('>' + heading + '</h2>'));
  assert.ok(card, 'Expected a visible frozen input summary');
  return card.split('<details')[0].replace(/<[^>]+>/g, ' ');
}

test('the report shows exact capture time and distinct stored holding currencies before the raw disclosure', () => {
  const html = renderReport({
    capturedAt: '2026-11-17T09:15:00+08:00',
    holdings: [{ ticker: 'AAA', currency: 'HKD' }, { ticker: 'BBB', currency: 'EUR' }, { ticker: 'CCC', currency: 'HKD' }],
    cashUsd: 500,
    opaque: '<original-input>',
  }, { source: { type: 'portfolio', id: 'portfolio-run-1' } });
  const text = summaryText(html);
  assert.match(text, /Captured at\s+2026-11-17T09:15:00\+08:00/);
  assert.match(text, /Holding currencies\s+HKD, EUR/);
  assert.match(text, /Report source\s+portfolio \/ portfolio-run-1/);
  assert.doesNotMatch(text, /USD|original-input|2026-11-19/);
  assert.match(html, /<details[^>]*><summary[^>]*>View raw snapshot<\/summary><pre[^>]*>[\s\S]*&lt;original-input&gt;/);
});

test('the default reader displays saved sources with their own times and fact currencies', () => {
  const html = renderReport({
    evidence: [{
      id: 'evidence-1', sourceName: 'Frozen report feed', fetchedAt: '2026-11-11T18:00:00Z',
      metadata: { sources: [{
        provider: 'Fictional filing archive', sourceUrl: 'https://example.test/filing',
        publishedAt: '2026-11-10', observedAt: '2026-11-11T12:00:00Z',
        facts: [{ currency: 'CAD' }],
      }, { provider: 'Fictional missing metadata', observedAt: null, facts: [{ currency: null }] }] },
    }],
  }, { simple: true });
  const text = summaryText(html);
  assert.match(text, /Captured at\s+Unknown/);
  assert.match(text, /Fictional filing archive/);
  assert.match(text, /https:\/\/example.test\/filing/);
  assert.match(text, /Published\s+2026-11-10/);
  assert.match(text, /Observed\s+2026-11-11T12:00:00Z/);
  assert.match(text, /Evidence currencies\s+CAD/);
  assert.match(text, /Fictional missing metadata\s+Published\s+Unknown\s+Observed\s+Unknown\s+Evidence currencies\s+Unknown/);
  assert.match(html, /<summary[^>]*>Frozen inputs at the time<\/summary>/);
});

test('older reports show unknowns for missing or unusable snapshot fields without using report dates', () => {
  for (const snapshot of [null, { capturedAt: '  ', holdings: [null, { currency: 123 }], evidence: {} }]) {
    const text = summaryText(renderReport(snapshot, { language: 'zh-CN' }), '固定输入快照');
    assert.match(text, /采集时间\s+未知/);
    assert.match(text, /币种\s+未知/);
    assert.match(text, /报告来源\s+未知/);
    assert.match(text, /输入来源\s+未知/);
    assert.doesNotMatch(text, /2026-11-(18|19)|portfolio-run/);
  }
});
