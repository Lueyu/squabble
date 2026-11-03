/** Bundled declarative research procedures; never executable user-installed code. */
export interface ResearchSkillFixture {
  kind: 'normal' | 'missing' | 'counterexample'; input: string; expected: string;
}
export interface ResearchSkillManifest {
  id: string; version: string; title: string; triggers: string[]; notFor: string[];
  input: string[]; output: string[]; steps: string[]; requiredTools: string[];
  dependencies: string[]; context: string; fixtures: ResearchSkillFixture[];
}
