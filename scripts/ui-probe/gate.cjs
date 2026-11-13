'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, matrixInfo, sourceTokenFingerprint, detectorFingerprint } = require('./fingerprints.cjs');

const weights = { P0: 10, P1: 3, P2: 1 };
const identity = finding => JSON.stringify([finding.code, finding.route, finding.state, finding.viewport, finding.selector]);
const score = snapshot => snapshot.findings.reduce((total, finding) => total + (weights[finding.sev] || 0), 0);
const sorted = values => [...values].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function validFindings(snapshot) {
  const scenarios = new Set(snapshot.scenarios.map(item => JSON.stringify([item.route, item.state, item.viewport])));
  const seen = new Set();
  return snapshot.findings.every(item => {
    if (!item || !['P0', 'P1', 'P2'].includes(item.sev)
      || !['code', 'selector', 'route', 'state', 'shot'].every(key => nonempty(item[key]))
      || !Number.isFinite(item.viewport)
      || !scenarios.has(JSON.stringify([item.route, item.state, item.viewport]))
      || !item.rect || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(item.rect[key]))
      || !item.metric || !Number.isFinite(item.metric.actual) || !Number.isFinite(item.metric.expected)
      || !['px', 'ratio', 'count'].includes(item.metric.unit)
      || !item.styles || typeof item.styles !== 'object' || Array.isArray(item.styles)
      || !Object.values(item.styles).every(value => typeof value === 'string')) return false;
    const key = item.sev + identity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evaluateGate(before, current, options = {}) {
  const reasons = new Set();
  if (![before, current].every(snapshot => snapshot && Array.isArray(snapshot.scenarios)
    && Array.isArray(snapshot.expectedScenarios) && Array.isArray(snapshot.findings))) {
    return { pass: false, reasons: ['INVALID_SNAPSHOT'] };
  }
  for (const snapshot of [before, current]) {
    if (!validFindings(snapshot)) reasons.add('INVALID_FINDING');
    if (snapshot.schemaVersion !== 1 || snapshot.status !== 'complete') reasons.add('INCOMPLETE_CAPTURE');
    const ids = snapshot.scenarios.map(item => item.id);
    if (new Set(ids).size !== ids.length || !same(ids, snapshot.expectedScenarios)
      || snapshot.scenarios.some(item => item.status !== 'complete')) reasons.add('SCENARIO_COVERAGE');
    if (options.expectedScenarios && !same(ids, options.expectedScenarios)) reasons.add('SCENARIO_COVERAGE');
    if (snapshot.matrixHash !== options.expectedMatrixHash) reasons.add('MATRIX_CHANGED');
    if (snapshot.tokenHash !== options.expectedTokenHash) reasons.add('TOKEN_SOURCE_CHANGED');
    if (snapshot.probeHash !== options.expectedProbeHash) reasons.add('DETECTOR_CHANGED');
  }
  if (!same(before.expectedScenarios, current.expectedScenarios)) reasons.add('MATRIX_CHANGED');
  if (before.matrixHash !== current.matrixHash) reasons.add('MATRIX_CHANGED');
  if (before.tokenHash !== current.tokenHash) reasons.add('TOKEN_SOURCE_CHANGED');
  if (before.probeHash !== current.probeHash) reasons.add('DETECTOR_CHANGED');
  if (JSON.stringify(before.environment) !== JSON.stringify(current.environment)) reasons.add('ENVIRONMENT_CHANGED');
  const previousP0 = new Set(before.findings.filter(item => item.sev === 'P0').map(identity));
  const previousP1 = new Set(before.findings.filter(item => ['P0', 'P1'].includes(item.sev)).map(identity));
  const newP0 = current.findings.filter(item => item.sev === 'P0' && !previousP0.has(identity(item)));
  const newP1 = current.findings.filter(item => item.sev === 'P1' && !previousP1.has(identity(item)));
  if (newP0.length) reasons.add('NEW_P0');
  if (newP1.length) reasons.add('NEW_P1');
  const beforeScore = score(before);
  const currentScore = score(current);
  const gain = beforeScore - currentScore;
  if (gain < (options.minGain ?? 8)) reasons.add('NO_NET_GAIN');
  return { pass: reasons.size === 0, reasons: [...reasons], beforeScore, currentScore, gain, newP0, newP1 };
}

function main(args = process.argv.slice(2)) {
  const get = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const beforePath = path.resolve(get('--vs', '.ui/baseline.json'));
  const currentPath = path.resolve(get('--current', 'output/playwright/ui-audit/after.json'));
  if (!fs.existsSync(beforePath)) throw new Error('Comparison snapshot missing: ' + beforePath + '. No approved baseline is created automatically. Use --vs <before.json> for this run.');
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const matrix = matrixInfo();
  const tokens = sourceTokenFingerprint();
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, '.ui/tokens.lock.json'), 'utf8'));
  const result = evaluateGate(before, current, {
    expectedMatrixHash: matrix.hash, expectedScenarios: matrix.scenarios.map(item => item.id),
    expectedTokenHash: tokens.hash, expectedProbeHash: detectorFingerprint(),
    minGain: Number(get('--min-gain', '8')),
  });
  if (tokens.hash !== lock.hash) {
    result.pass = false;
    result.reasons.push('TOKEN_LOCK_CHANGED');
  }
  if (!Number.isFinite(Number(get('--min-gain', '8'))) || Number(get('--min-gain', '8')) < 1) {
    throw new Error('--min-gain must be a positive number; net improvement is mandatory.');
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.pass ? 0 : 1;
  return result;
}

module.exports = { evaluateGate, identity, score, main };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
