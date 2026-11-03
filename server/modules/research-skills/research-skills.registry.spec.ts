import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDelivery } from '../council/council.tasks';
import { BUNDLED_RESEARCH_SKILLS, pinResearchSkills, validateResearchSkills } from './research-skills.registry';

test('bundled skills have deterministic pins, minimal selection and three documented fixture cases', () => {
  assert.equal(BUNDLED_RESEARCH_SKILLS.length, 4);
  assert.equal(validateResearchSkills(BUNDLED_RESEARCH_SKILLS).length, 4);
  for (const kind of ['financials', 'business', 'valuation', 'challenge'] as const) {
    const pins = pinResearchSkills(kind);
    assert.equal(pins.length, 1);
    assert.match(pins[0].hash, /^[a-f0-9]{64}$/);
    assert.match(pins[0].version, /^1\.0\.0$/);
    assert.ok(pins[0].context.length > 100 && Buffer.byteLength(pins[0].context) <= 8000);
    assert.deepEqual(pins, pinResearchSkills(kind));
    pins[0].context = 'caller mutation';
    assert.ok(!pinResearchSkills(kind)[0].context.includes('caller mutation'));
  }
  assert.deepEqual(pinResearchSkills('summary'), []);
  for (const skill of BUNDLED_RESEARCH_SKILLS) {
    assert.deepEqual(skill.fixtures.map(item => item.kind), ['normal', 'missing', 'counterexample']);
    for (const fixture of skill.fixtures) {
      assert.ok(fixture.input.length && fixture.expected.length);
      assert.match(skill.context, /untrusted|instructions/i);
    }
  }
});

test('registry rejects traversal, invalid versions, collisions, missing dependencies and oversized context', () => {
  const base = BUNDLED_RESEARCH_SKILLS[0];
  for (const change of [{ id: '../outside' }, { id: 'a/b' }, { id: 'a\\b' }, { version: 'latest' },
    { context: 'x'.repeat(8001) }, { requiredTools: ['trade'] }, { dependencies: ['missing@1.0.0'] }]) {
    assert.throws(() => validateResearchSkills([{ ...base, ...change }]), /RESEARCH_SKILL_/);
  }
  assert.throws(() => validateResearchSkills([base, { ...base }]), /RESEARCH_SKILL_CONFLICT/);
  assert.throws(() => validateResearchSkills([{ ...base, dependencies: [`${base.id}@${base.version}`] }]), /RESEARCH_SKILL_DEPENDENCY/);
});

test('bundled manifests are immutable so pins cannot silently change during a running process', () => {
  const before = pinResearchSkills('financials');
  assert.equal(Reflect.set(BUNDLED_RESEARCH_SKILLS[0], 'version', '9.0.0'), false);
  assert.throws(() => { BUNDLED_RESEARCH_SKILLS[0].steps.push('Injected instruction'); }, TypeError);
  assert.deepEqual(pinResearchSkills('financials'), before);
});

test('retained versions default to highest semantic version and rollback only changes future pins', () => {
  const first = BUNDLED_RESEARCH_SKILLS[0];
  const second = { ...first, version: '1.10.0', steps: ['Use the revised procedure.'] };
  const bundles = [second, first, { ...first, version: '1.2.0' }];
  assert.equal(validateResearchSkills(bundles).length, 3);
  const oldTask = { skills: pinResearchSkills('financials', { bundles, versions: '{}' }) };
  const storedSnapshot = JSON.stringify(oldTask);
  assert.equal(oldTask.skills[0].version, '1.10.0');
  assert.deepEqual(pinResearchSkills('financials', { bundles: [...bundles].reverse(), versions: '{}' }), oldTask.skills);
  const newPins = pinResearchSkills('financials', { bundles,
    versions: JSON.stringify({ [first.id]: first.version }) });
  assert.equal(newPins[0].version, '1.0.0');
  assert.notEqual(newPins[0].hash, oldTask.skills[0].hash);
  assert.match(newPins[0].context, /financial-verification@1\.0\.0/u);
  assert.equal(JSON.stringify(oldTask), storedSnapshot);
  const oldDelivery = { conclusion: 'The stored task retains its reviewed procedure.', evidenceIds: [],
    asOf: '2026-11-03', currency: null, units: 'Unavailable', assumptions: [], gaps: ['No source supplied.'],
    skillVersions: oldTask.skills.map(({ id, version, hash }) => ({ id, version, hash })),
    response: { thesis: 'Coverage remains missing.', evidencePoints: [], risks: [], nextChecks: [] } };
  assert.deepEqual(validateDelivery(oldDelivery, new Set(), oldTask.skills).skillVersions, oldDelivery.skillVersions);
  assert.throws(() => validateDelivery(oldDelivery, new Set(), newPins), /DELIVERY_SKILL_VERSION_INVALID/u);
  assert.throws(() => validateResearchSkills([...bundles, { ...second }]), /RESEARCH_SKILL_CONFLICT/u);
});

test('version selection rejects malformed configuration and unknown id/version pins', () => {
  for (const versions of ['', '{', 'null', '[]', '1', '{"financial-verification":1}',
    '{"financial-verification":"latest"}', '{"unknown":"1.0.0"}',
    '{"financial-verification":"9.0.0"}']) {
    assert.throws(() => pinResearchSkills('financials', { versions }), /RESEARCH_SKILL_VERSION_CONFIG/u, versions);
  }
  assert.throws(() => pinResearchSkills('summary', { versions: '{' }), /RESEARCH_SKILL_VERSION_CONFIG/u);
});

test('operator environment pin is validated and affects new task snapshots', () => {
  const previous = process.env.RESEARCH_SKILL_VERSIONS;
  try {
    process.env.RESEARCH_SKILL_VERSIONS = '{"financial-verification":"1.0.0"}';
    assert.equal(pinResearchSkills('financials')[0].version, '1.0.0');
    process.env.RESEARCH_SKILL_VERSIONS = '{"financial-verification":"9.0.0"}';
    assert.throws(() => pinResearchSkills('financials'), /RESEARCH_SKILL_VERSION_CONFIG/u);
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_SKILL_VERSIONS;
    else process.env.RESEARCH_SKILL_VERSIONS = previous;
  }
});

test('dependencies retain their exact version despite default and operator selection', () => {
  const first = BUNDLED_RESEARCH_SKILLS[0];
  const second = { ...first, version: '2.0.0' };
  const root = { ...BUNDLED_RESEARCH_SKILLS[2], dependencies: [`${first.id}@${first.version}`] };
  const bundles = [first, second, root];
  const pins = pinResearchSkills('valuation', { bundles, versions: JSON.stringify({ [first.id]: second.version }) });
  assert.deepEqual(pins.map(pin => `${pin.id}@${pin.version}`), ['financial-verification@1.0.0', 'valuation-ranges@1.0.0']);
  const conflict = { ...root, dependencies: [`${first.id}@${first.version}`, `${second.id}@${second.version}`] };
  assert.throws(() => pinResearchSkills('valuation', { bundles: [first, second, conflict], versions: '{}' }),
    /RESEARCH_SKILL_DEPENDENCY/u);
  const nestedConflict = { ...second, dependencies: [`${first.id}@${first.version}`] };
  assert.throws(() => pinResearchSkills('financials', { bundles: [first, nestedConflict], versions: '{}' }),
    /RESEARCH_SKILL_DEPENDENCY/u);
});
