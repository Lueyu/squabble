import type { LocalAgentProvider } from './local-agents.interface';

/** Public connection metadata; executable resolution stays inside the native runtime. */
export const providerCatalog: Record<LocalAgentProvider, {
  provider: LocalAgentProvider; name: string; installUrl: string; loginCommand: string;
}> = {
  codex: { provider: 'codex', name: 'Codex', installUrl: 'https://developers.openai.com/codex/cli/', loginCommand: 'codex login' },
  claude: { provider: 'claude', name: 'Claude Code', installUrl: 'https://code.claude.com/docs/en/setup', loginCommand: 'claude auth login' },
  gemini: { provider: 'gemini', name: 'Gemini CLI', installUrl: 'https://geminicli.com/docs/get-started/installation/', loginCommand: 'gemini' },
  antigravity: { provider: 'antigravity', name: 'Antigravity', installUrl: 'https://antigravity.google/download', loginCommand: 'agy' },
  opencode: { provider: 'opencode', name: 'OpenCode', installUrl: 'https://opencode.ai/docs/', loginCommand: 'opencode auth login' },
  kimi: { provider: 'kimi', name: 'Kimi Code', installUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html', loginCommand: 'kimi login' },
  doubao: { provider: 'doubao', name: 'Doubao Agent', installUrl: 'https://github.com/Fullstop000/doubao-cli', loginCommand: 'doubao headless login' },
};
