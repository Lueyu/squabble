import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalAgentProvider, NativeAgentConfiguration, NativeAgentModel } from '../../shared/local-agents.interface';
import { configuredModels, DEFAULT_EFFORTS, geminiEfforts, jsonValues, kimiMetadata, object, parseModels, readLocalText, supportsAntigravity } from './metadata';
import type { NativeProcessResult } from './process';
import type { NativeResolverOptions } from './resolver';

export interface ResearchInvocation { args: string[]; input: string; env: NodeJS.ProcessEnv }
export type NativeProbe = (args: string[], context?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<NativeProcessResult>;
const RESEARCH_INSTRUCTIONS: string = 'Research the user request with sources. Return a complete report. Use only the provided read and web research tools.';

export function normalizedConfiguration(settings: NativeAgentConfiguration | undefined): NativeAgentConfiguration {
  if (!settings) return {};
  const result: NativeAgentConfiguration = {};
  for (const key of ['model', 'reasoningEffort'] as const) {
    const value: unknown = settings[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > (key === 'model' ? 160 : 32)
      || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('NATIVE_AGENT_INVALID_CONFIGURATION');
    result[key] = value.trim();
  }
  return result;
}

async function privateFile(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
}

/** All overrides are invocation-scoped; never mutate the user's native CLI settings. */
export async function researchInvocation(provider: LocalAgentProvider, prompt: string, settings: NativeAgentConfiguration,
  cwd: string, environment: NodeJS.ProcessEnv, options: NativeResolverOptions, probe: NativeProbe): Promise<ResearchInvocation> {
  const env: NodeJS.ProcessEnv = { ...environment };
  const model: string | undefined = settings.model;
  const effort: string | undefined = settings.reasoningEffort;
  const cachedEfforts: string[] | undefined = provider === 'codex'
    ? configuredModels('codex', options).find((row: NativeAgentModel) => row.id === model)?.reasoningEfforts
    : provider === 'gemini' ? geminiEfforts(model ?? '') : undefined;
  if (effort && !['opencode', 'kimi'].includes(provider) && !(cachedEfforts ?? DEFAULT_EFFORTS[provider]).includes(effort)) {
    throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
  }
  const modelArgs: string[] = model ? ['--model', model] : [];
  if (provider === 'codex') return { env, input: prompt, args: [
    '--search', '--ask-for-approval', 'never', 'exec', '--json', '--sandbox', 'read-only',
    '--ephemeral', '--skip-git-repo-check', ...modelArgs, ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []), '-',
  ] };
  if (provider === 'claude') return { env, input: prompt, args: [
    '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', ...modelArgs,
    ...(effort ? ['--effort', effort] : []), '--tools', 'WebSearch,WebFetch,Read,Glob,Grep',
    '--allowedTools', 'WebSearch,WebFetch,Read,Glob,Grep', '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--settings', '{"disableAllHooks":true}',
  ] };
  if (provider === 'gemini') {
    if (effort && (!model || !geminiEfforts(model).includes(effort))) {
      throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
    }
    const tools: string[] = ['google_web_search', 'web_fetch', 'read_file', 'read_many_files', 'list_directory', 'glob', 'grep_search'];
    const configPath: string = join(cwd, '.squabble', 'gemini-settings.json');
    await privateFile(configPath, JSON.stringify({
      tools: { core: tools, allowed: tools, discoveryCommand: '', callCommand: '' }, hooksConfig: { enabled: false },
      admin: { extensions: { enabled: false }, mcp: { enabled: false }, skills: { enabled: false } },
      ...(effort ? { modelConfigs: { overrides: [{ match: { model }, modelConfig: {
        generateContentConfig: { thinkingConfig: { thinkingLevel: effort.toUpperCase(), includeThoughts: false } },
      } }] } } : {}),
    }));
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configPath;
    return { env, input: prompt, args: ['--output-format', 'stream-json', '--approval-mode', 'default', ...modelArgs] };
  }
  if (provider === 'antigravity') {
    const version = await probe(['--version']);
    if (version.code !== 0 || !supportsAntigravity(version.stdout)) throw new Error('NATIVE_AGENT_VERSION_UNSUPPORTED');
    if (model && effort) {
      const models = await probe(['--output-format', 'json', 'models']);
      const supported = parseModels('antigravity', models.stdout).find((row: NativeAgentModel) => row.id === model)?.reasoningEfforts;
      if (supported && !supported.includes(effort)) throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
    }
    const geminiDir: string = join(cwd, '.squabble', 'agy');
    const accountData: string = join(options.home ?? homedir(), '.gemini', 'antigravity-cli');
    const saved = object(jsonValues(readLocalText(join(accountData, 'settings.json')))[0]);
    const identity: Record<string, unknown> = {};
    for (const key of ['model', 'modelProvider', 'gcp', 'customModelsConfig']) if (saved[key] !== undefined) identity[key] = saved[key];
    await privateFile(join(geminiDir, 'antigravity-cli', 'settings.json'), JSON.stringify({ ...identity,
      toolPermission: 'request-review', allowNonWorkspaceAccess: false, enableTerminalSandbox: true,
      trustedWorkspaces: [cwd],
      permissions: { allow: ['read_url(*)'], deny: ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'mcp(*)', 'execute_url(*)'] },
    }));
    await privateFile(join(geminiDir, 'config', 'mcp_config.json'), '{"mcpServers":{}}');
    await privateFile(join(geminiDir, 'config', 'agents', 'squabble-research', 'agent.md'), [
      '---', 'name: squabble-research', 'description: Read-only financial research', 'mainAgent: true',
      'subagent: false', 'commandExecutionPolicy: off', 'inheritMcp: false', 'tools:',
      ...['view_file', 'list_dir', 'grep_search', 'find_by_name', 'read_url_content', 'search_web'].map((tool: string) => `  - ${tool}`),
      '---', RESEARCH_INSTRUCTIONS,
    ].join('\n'));
    env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
    // Keyring identity stays with the unchanged OS user; settings and session data belong only to this invocation.
    const profileArgs: string[] = [`--gemini_dir=${geminiDir}`, '--app_data_dir=antigravity-cli'];
    const auth = await probe([...profileArgs, '-p', '/usage', '--output-format', 'json']);
    if (auth.code !== 0) throw new Error('NATIVE_AGENT_LOGIN_REQUIRED');
    return { env, input: `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`, args: [
      ...profileArgs, '--agent', 'squabble-research',
      '--sandbox', '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json',
      ...modelArgs, ...(effort ? ['--effort', effort] : []),
    ] };
  }
  if (provider === 'opencode') {
    if (effort) {
      const catalog: NativeProcessResult = await probe(['models', '--verbose']);
      const selected: NativeAgentModel | undefined = parseModels('opencode', catalog.stdout).find((row: NativeAgentModel) => row.id === model);
      if (catalog.code !== 0 || !selected?.reasoningEfforts?.includes(effort)) throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
    }
    const permissions = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', webfetch: 'allow', websearch: 'allow' };
    env.OPENCODE_PERMISSION = JSON.stringify(permissions);
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: permissions, agent: { 'squabble-research': {
      description: 'Read-only research', mode: 'primary', prompt: RESEARCH_INSTRUCTIONS, permission: permissions,
    } } });
    return { env, input: prompt, args: ['run', '--format', 'json', '--print-logs', '--log-level', 'ERROR',
      '--agent', 'squabble-research', ...modelArgs, ...(effort ? ['--variant', effort] : [])] };
  }
  if (provider === 'kimi') {
    const doctor: NativeProcessResult = await probe(['doctor', 'config']);
    if (doctor.code !== 0) throw new Error('NATIVE_AGENT_VERSION_UNSUPPORTED');
    if (effort) {
      const metadata = kimiMetadata(options);
      const selected = metadata.models.find((row: NativeAgentModel) => row.id === (model ?? metadata.defaultModel));
      if (!selected?.reasoningEfforts?.includes(effort)) throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
      env.KIMI_MODEL_THINKING_EFFORT = effort;
    }
    const agent: string = join(cwd, '.squabble', 'kimi-research.md');
    await privateFile(agent, ['---', 'name: squabble-research', 'description: Read-only financial research',
      'tools: [Read, Glob, Grep, WebSearch, WebFetch]', 'subagents: []', '---', RESEARCH_INSTRUCTIONS].join('\n'));
    env.KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT = 'false';
    env.KIMI_CODE_NO_AUTO_UPDATE = '1';
    env.KIMI_DISABLE_CRON = '1';
    // Native Kimi takes the prompt as a single argv value; no shell is involved.
    return { env, input: '', args: ['--prompt', prompt, '--output-format', 'stream-json', '--agent-file', agent, ...modelArgs] };
  }
  return { env, input: '', args: ['headless', 'sessions', 'create', '--mode', 'work', '--runtime', 'cloud', '--json',
    ...modelArgs, ...(effort ? ['--reasoning', effort] : []), '--', prompt] };
}
