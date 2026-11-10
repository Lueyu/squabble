/** Bundled declarative research procedures; never executable user-installed code. */
export interface ResearchSkillFixture {
  kind: 'normal' | 'missing' | 'counterexample'; input: string; expected: string;
}
export interface ResearchSkillManifest {
  id: string; version: string; title: string; triggers: string[]; notFor: string[];
  input: string[]; output: string[]; steps: string[]; requiredTools: string[];
  dependencies: string[]; context: string; fixtures: ResearchSkillFixture[];
}

/** Public discovery metadata. Only the server resolves executable, pinned instructions. */
export interface ResearchSkillDescriptor {
  id: string; command: string; title: string; titleEn: string;
  description: string; descriptionEn: string; version: string;
  mode: 'research' | 'interview'; requiredTools: string[];
}
export interface ResearchSkillIdentity { id: string; version: string; title: string }
