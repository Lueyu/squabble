import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResearchSkillManifest } from '@shared/research-skills.interface';
import type { ResearchSkillPin, ResearchTaskKind } from '@shared/research-workflow.interface';
import { RESEARCH_TOOLS } from '../research-tools/research-tools.registry';
import { SKILL_BUNDLES } from './research-skills.bundled';

const line = z.string().trim().min(1).max(1200);
const lines = z.array(line).min(1).max(12);
const manifest = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u).max(64),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u).max(32),
  title: line, triggers: lines, notFor: lines, input: lines, output: lines, steps: lines,
  requiredTools: z.array(z.string()).min(1).max(10), dependencies: z.array(z.string().max(100)).max(8),
  context: z.string().min(1).refine(value => Buffer.byteLength(value) <= 8000),
  fixtures: z.array(z.strictObject({ kind: z.enum(['normal', 'missing', 'counterexample']), input: line, expected: line })).length(3),
});

export function validateResearchSkills(value: unknown): ResearchSkillManifest[] {
  const parsed = z.array(manifest).max(16).safeParse(value);
  if (!parsed.success) throw new Error('RESEARCH_SKILL_INVALID_MANIFEST');
  const skills: ResearchSkillManifest[] = parsed.data;
  const pins = new Set<string>(); const visited = new Set<string>();
  const byPin = new Map(skills.map(skill => [`${skill.id}@${skill.version}`, skill]));
  for (const skill of skills) {
    const key = `${skill.id}@${skill.version}`;
    if (pins.has(key)) throw new Error('RESEARCH_SKILL_CONFLICT');
    pins.add(key);
    if (new Set(skill.fixtures.map(fixture => fixture.kind)).size !== 3
      || new Set(skill.requiredTools).size !== skill.requiredTools.length
      || skill.requiredTools.some(name => !RESEARCH_TOOLS.some(tool => tool.name === name))) {
      throw new Error('RESEARCH_SKILL_INVALID_MANIFEST');
    }
  }
  const visit = (skill: ResearchSkillManifest, parents: Set<string>): void => {
    const key = `${skill.id}@${skill.version}`;
    if (parents.has(key)) throw new Error('RESEARCH_SKILL_DEPENDENCY');
    if (visited.has(key)) return;
    for (const reference of skill.dependencies) {
      const dependency = byPin.get(reference);
      if (!dependency) throw new Error('RESEARCH_SKILL_DEPENDENCY');
      visit(dependency, new Set([...parents, key]));
    }
    visited.add(key);
    if (Buffer.byteLength(skillContext(skill)) > 8000) throw new Error('RESEARCH_SKILL_CONTEXT_LIMIT');
  };
  for (const skill of skills) visit(skill, new Set());
  return skills;
}

function skillContext(skill: ResearchSkillManifest): string {
  return [`Research skill: ${skill.id}@${skill.version} — ${skill.title}`, skill.context,
    `Not for: ${skill.notFor.join('; ')}`, `Required read-only tools: ${skill.requiredTools.join(', ')}`,
    ...skill.steps.map((step, index) => `${index + 1}. ${step}`)].join('\n');
}

function freezeManifest(skill: ResearchSkillManifest): ResearchSkillManifest {
  for (const field of ['triggers', 'notFor', 'input', 'output', 'steps', 'requiredTools', 'dependencies'] as const) {
    Object.freeze(skill[field]);
  }
  skill.fixtures.forEach(Object.freeze); Object.freeze(skill.fixtures);
  return Object.freeze(skill);
}
export const BUNDLED_RESEARCH_SKILLS: readonly ResearchSkillManifest[] = Object.freeze(validateResearchSkills(SKILL_BUNDLES).map(freezeManifest));
const SELECTION: Record<ResearchTaskKind, string | null> = { financials: 'financial-verification',
  business: 'peer-comparison', valuation: 'valuation-ranges', challenge: 'contrarian-invalidation', summary: null, specialist: null };

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(BigInt); const b = right.split('.').map(BigInt);
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function versionSelection(raw: string | undefined, bundles: readonly ResearchSkillManifest[]): Map<string, string> {
  if (raw === undefined) return new Map();
  try {
    if (Buffer.byteLength(raw) > 4096) throw new Error();
    const parsed = z.record(manifest.shape.id, manifest.shape.version).parse(JSON.parse(raw));
    const pins = new Map(Object.entries(parsed));
    for (const [id, version] of pins) {
      if (!bundles.some(skill => skill.id === id && skill.version === version)) throw new Error();
    }
    return pins;
  } catch { throw new Error('RESEARCH_SKILL_VERSION_CONFIG'); }
}

/** Return fresh immutable-by-ownership values. Persist the entire pin once; retries use the stored context. */
export function pinResearchSkills(kind: ResearchTaskKind,
  options: { bundles?: readonly ResearchSkillManifest[]; versions?: string } = {}): ResearchSkillPin[] {
  const id = SELECTION[kind];
  if (id) return pinResearchSkill(id, options);
  const bundles = options.bundles ? validateResearchSkills(options.bundles) : BUNDLED_RESEARCH_SKILLS;
  versionSelection(options.versions ?? process.env.RESEARCH_SKILL_VERSIONS, bundles);
  return [];
}

export function pinResearchSkill(id: string,
  options: { bundles?: readonly ResearchSkillManifest[]; versions?: string } = {}): ResearchSkillPin[] {
  // Only trusted bundled source/config enters here; never resolve native CLI directories or request-supplied skills.
  const bundles = options.bundles ? validateResearchSkills(options.bundles) : BUNDLED_RESEARCH_SKILLS;
  const versions = versionSelection(options.versions ?? process.env.RESEARCH_SKILL_VERSIONS, bundles);
  const candidates = bundles.filter(skill => skill.id === id)
    .sort((a, b) => compareVersions(b.version, a.version));
  const root = versions.has(id) ? candidates.find(skill => skill.version === versions.get(id)) : candidates[0];
  if (!root) throw new Error('RESEARCH_SKILL_UNAVAILABLE');
  const selected = new Map<string, ResearchSkillManifest>();
  const add = (skill: ResearchSkillManifest): void => {
    const existing = selected.get(skill.id);
    if (existing?.version === skill.version) return;
    if (existing) throw new Error('RESEARCH_SKILL_DEPENDENCY');
    for (const dependency of skill.dependencies) add(bundles.find(item => `${item.id}@${item.version}` === dependency)!);
    if (selected.has(skill.id)) throw new Error('RESEARCH_SKILL_DEPENDENCY');
    selected.set(skill.id, skill);
  };
  add(root);
  return [...selected.values()].map(skill => ({ id: skill.id, version: skill.version,
    hash: createHash('sha256').update(JSON.stringify(skill)).digest('hex'), context: skillContext(skill) }));
}
