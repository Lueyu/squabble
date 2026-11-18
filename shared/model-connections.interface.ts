export type ModelConnectionTestState = 'pending' | 'failed' | 'passed';

/** User-owned OpenAI-compatible connections; public responses never contain credentials. */
export interface ModelConnection {
  id: string;
  name: string;
  baseUrl: string;
  fastModel: string;
  slowModel: string;
  hasApiKey: boolean;
  available: boolean;
  testState?: ModelConnectionTestState;
  testedAt?: string;
  maskedApiKey?: string;
  needsReentry?: boolean;
}
export interface SaveModelConnection {
  name: string;
  baseUrl: string;
  fastModel: string;
  slowModel: string;
  apiKey?: string;
}
