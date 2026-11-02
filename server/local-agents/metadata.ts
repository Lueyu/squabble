import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalAgentProvider, NativeAgentModel, NativeAgentStatus } from '../../shared/local-agents.interface';
import type { NativeProcessResult } from './process';
import type { NativeResolverOptions } from './resolver';

export interface JsonObject { [key: string]: unknown }
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
export function readLocalText(path: string): string {
  try { return statSync(path).size <= 1024 * 1024 ? readFileSync(path, 'utf8') : ''; } catch { return ''; }
}
export function jsonValues(text: string): unknown[] {
  try { return [JSON.parse(text)]; } catch { /* Some CLIs prefix JSON with notices or model IDs. */ }
  const values: unknown[] = [];
  let start: number = -1; let depth: number = 0; let quoted: boolean = false; let escaped: boolean = false;
  for (let i: number = 0; i < text.length; i++) {
    const char: string = text[i];
    if (start < 0) { if (char === '{' || char === '[') { start = i; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (--depth !== 0) continue;
      try { values.push(JSON.parse(text.slice(start, i + 1))); } catch { /* Skip non-JSON diagnostics. */ }
      start = -1;
    }
  }
  return values;
}
function jsonFile(path: string): JsonObject { return object(jsonValues(readLocalText(path))[0]); }
function validLabel(value: unknown, length: number = 160): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= length && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function effortValues(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item: unknown): item is string => validLabel(item, 32)))].slice(0, 16) : [];
}
export const DEFAULT_EFFORTS: Record<LocalAgentProvider, string[]> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'max'],
  gemini: [], antigravity: ['low', 'medium', 'high', 'max'], opencode: [], kimi: [],
  doubao: ['low', 'medium', 'high', 'xhigh', 'max'],
};
const HELP: Record<LocalAgentProvider, string> = {
  codex: 'Uses codex login and your native model configuration. Model IDs can also be entered manually; the CLI validates model/effort compatibility.',
  claude: 'Uses Claude Code authentication. Enter a native model name or alias; effort support depends on the selected model and CLI version.',
  gemini: 'Uses Gemini CLI credentials. Readiness checks local credentials without a paid request. Thinking overrides require an explicitly listed Gemini model; other models and automatic routing use native defaults.',
  antigravity: 'Requires native agy >=1.3.4 with a reusable OS keyring login or API/ADC credentials. Models come from agy models. Research uses disposable settings, a read-only agent and an authentication preflight; file-only login profiles may require native keyring setup.',
  opencode: 'Uses OpenCode provider connections. Enter provider/model; reasoning choices are the variants advertised by opencode models --verbose.',
  kimi: 'Requires current @moonshot-ai/kimi-code, not the retired Python kimi-cli. Models and supported effort levels are read from local config.toml; local credentials are checked without a paid request.',
  doubao: 'Community doubao-cli bridge (not an official ByteDance CLI). Uses headless login and cloud Work tasks. Exact live model names are required. Tasks remain in Doubao history; cancellation calls sessions stop.',
};
const GEMINI_THINKING_MODELS: ReadonlySet<string> = new Set([
  'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools',
]);
export function geminiEfforts(model: string): string[] { return GEMINI_THINKING_MODELS.has(model) ? ['low', 'high'] : []; }
export function supportsAntigravity(version: string): boolean {
  const match: RegExpMatchArray | null = version.match(/\b(\d+)\.(\d+)\.(\d+)/u);
  return Boolean(match && (Number(match[1]) > 1 || (Number(match[1]) === 1 && (Number(match[2]) > 3 || (Number(match[2]) === 3 && Number(match[3]) >= 4)))));
}
export function defaultCapabilities(provider: LocalAgentProvider): Pick<NativeAgentStatus, 'models' | 'reasoningEfforts' | 'configurationHelp'> {
  return { models: [], reasoningEfforts: [...DEFAULT_EFFORTS[provider]], configurationHelp: HELP[provider] };
}

export function configuredModels(provider: 'codex' | 'claude', options: NativeResolverOptions): NativeAgentModel[] {
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const home: string = options.home ?? homedir();
  if (provider === 'claude') {
    const settings: JsonObject = jsonFile(join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json'));
    const model: unknown = env.ANTHROPIC_MODEL ?? settings.model;
    return [...new Set([...(validLabel(model) ? [model] : []), 'opus', 'sonnet', 'haiku'])].map((id: string) => ({ id, name: id }));
  }
  const root: string = env.CODEX_HOME ?? join(home, '.codex');
  const cache: JsonObject = jsonFile(join(root, 'models_cache.json'));
  const models: NativeAgentModel[] = [];
  for (const raw of Array.isArray(cache.models) ? cache.models : []) {
    const row: JsonObject = object(raw);
    if (!validLabel(row.slug) || row.visibility === 'hide' || row.visibility === 'hidden') continue;
    const efforts: string[] = effortValues(Array.isArray(row.supported_reasoning_levels)
      ? row.supported_reasoning_levels.map((level: unknown) => object(level).effort) : []);
    models.push({ id: row.slug, name: validLabel(row.display_name) ? row.display_name : row.slug,
      ...(Array.isArray(row.supported_reasoning_levels) ? { reasoningEfforts: efforts } : {}) });
  }
  const config: JsonObject | undefined = tomlSections(readLocalText(join(root, 'config.toml'))).get('');
  if (validLabel(config?.model) && !models.some((model: NativeAgentModel) => model.id === config.model)) models.unshift({ id: config.model, name: config.model });
  return models.slice(0, 256);
}

/** Reads only CLI-generated scalar metadata, never returns credential values. */
export function tomlSections(text: string): Map<string, JsonObject> {
  const sections: Map<string, JsonObject> = new Map([['', {}]]);
  let current: JsonObject = sections.get('')!;
  for (const raw of text.split(/\r?\n/)) {
    const line: string = raw.trim();
    const header: RegExpMatchArray | null = line.match(/^\[([^\[\]]+)\]\s*(?:#.*)?$/u);
    if (header) {
      const parts: string[] = header[1].match(/"(?:\\.|[^"\\])*"|'[^']*'|[^.\s]+/gu) ?? [];
      const key: string = parts.map((part: string) => part.replace(/^['"]|['"]$/gu, '')).join('.');
      current = sections.get(key) ?? {}; sections.set(key, current); continue;
    }
    const field: RegExpMatchArray | null = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/u);
    if (!field) continue;
    const value: string = field[2].replace(/\s+#.*$/u, '').trim();
    try { current[field[1]] = JSON.parse(value); }
    catch { if (/^'[^']*'$/u.test(value)) current[field[1]] = value.slice(1, -1); }
  }
  return sections;
}
function allowedCredentialName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)
    && /KEY|TOKEN|CREDENTIAL|SECRET/iu.test(name)
    && !/^(?:SQUABBLE|DATABASE|DB_|PG|MYSQL|MONGO|REDIS|SESSION|JWT|LOCAL_AGENT|AGENT_GATEWAY|SETTINGS_ENCRYPTION|PAIR|NODE|ELECTRON|BUN|LD_|DYLD|PYTHON|RUBY|PERL|DOTNET)/iu.test(name);
}
/** Forward only the selected native provider's explicitly named credential, never application secrets. */
export function kimiCredentialEnv(options: NativeResolverOptions, model?: string): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = options.env ?? process.env;
  const root: string = source.KIMI_CODE_HOME ?? join(options.home ?? homedir(), '.kimi-code');
  const sections = tomlSections(readLocalText(join(root, 'config.toml')));
  const selected: unknown = model ?? sections.get('')?.default_model;
  const provider: unknown = typeof selected === 'string' ? sections.get(`models.${selected}`)?.provider : undefined;
  const key: unknown = typeof provider === 'string' ? sections.get(`providers.${provider}`)?.api_key_env : undefined;
  return allowedCredentialName(key) && source[key]?.trim() ? { [key]: source[key] } : {};
}
export function kimiMetadata(options: NativeResolverOptions): { models: NativeAgentModel[]; state: NativeAgentStatus['state']; defaultModel?: string; thinkingDisabled: boolean } {
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const root: string = env.KIMI_CODE_HOME ?? join(options.home ?? homedir(), '.kimi-code');
  const sections = tomlSections(readLocalText(join(root, 'config.toml')));
  const models: NativeAgentModel[] = [];
  const defaultModel: unknown = sections.get('')?.default_model;
  const thinkingDisabled: boolean = sections.get('thinking')?.enabled === false;
  let configured: boolean = false;
  for (const [key, value] of sections) {
    if (!key.startsWith('models.') || !validLabel(value.model) || typeof value.provider !== 'string') continue;
    const id: string = key.slice('models.'.length);
    if (!validLabel(id) || id.endsWith('.overrides')) continue;
    const provider: JsonObject = sections.get(`providers.${value.provider}`) ?? {};
    const overrides: JsonObject = sections.get(`${key}.overrides`) ?? {};
    const efforts: string[] = provider.type === 'kimi' && !thinkingDisabled ? effortValues(overrides.support_efforts ?? value.support_efforts) : [];
    models.push({ id, name: validLabel(value.display_name) ? value.display_name : id, reasoningEfforts: efforts });
    if (id !== defaultModel) continue;
    if (typeof provider.api_key === 'string' && provider.api_key.trim()) configured = true;
    if (allowedCredentialName(provider.api_key_env) && env[provider.api_key_env]?.trim()) configured = true;
    const providerEnv: JsonObject = sections.get(`providers.${value.provider}.env`) ?? {};
    if (Object.entries(providerEnv).some(([name, secret]) => /_API_KEY$/u.test(name) && typeof secret === 'string' && secret.trim())) configured = true;
    const oauth: JsonObject = sections.get(`providers.${value.provider}.oauth`) ?? object(provider.oauth);
    if (oauth.storage === 'file' && typeof oauth.key === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(oauth.key)) {
      const credential: JsonObject = jsonFile(join(root, 'credentials', `${oauth.key}.json`));
      configured ||= [credential.refresh_token, credential.access_token].some((token: unknown) => typeof token === 'string' && token.trim().length > 0);
    }
  }
  if (env.KIMI_MODEL_NAME && env.KIMI_MODEL_API_KEY) configured = true;
  return { models: models.slice(0, 256), state: configured ? 'ready' : 'login_required',
    defaultModel: typeof defaultModel === 'string' ? defaultModel : undefined, thinkingDisabled };
}

export function geminiMetadata(options: NativeResolverOptions): { state: NativeAgentStatus['state']; models: NativeAgentModel[] } {
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const root: string = join(env.GEMINI_CLI_HOME ?? options.home ?? homedir(), '.gemini');
  const settings: JsonObject = jsonFile(join(root, 'settings.json'));
  const selected: unknown = object(object(settings.security).auth).selectedType;
  const oauth: JsonObject = jsonFile(join(root, 'oauth_creds.json'));
  const api: boolean = Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  const configured: boolean = selected === 'oauth-personal' ? Boolean(oauth.refresh_token || oauth.access_token)
    : selected === 'vertex-ai' ? api || Boolean(env.GOOGLE_APPLICATION_CREDENTIALS && readLocalText(env.GOOGLE_APPLICATION_CREDENTIALS)) : api;
  const ids: string[] = [...Object.keys(object(object(settings.modelConfigs).aliases)), ...GEMINI_THINKING_MODELS];
  const model: unknown = object(settings.model).name;
  if (validLabel(model)) ids.unshift(model);
  return { state: configured ? 'ready' : 'login_required', models: [...new Set(ids)].filter((id: string) => validLabel(id)).slice(0, 256)
    .map((id: string) => ({ id, name: id, reasoningEfforts: geminiEfforts(id) })) };
}

export function parseModels(provider: LocalAgentProvider, text: string): NativeAgentModel[] {
  const rows: unknown[] = jsonValues(text).flatMap((value: unknown) => {
    if (Array.isArray(value)) return value;
    const row: JsonObject = object(value);
    const models: unknown = row.models ?? object(object(row.command).data).models;
    return Array.isArray(models) ? models : [value];
  });
  const models: Map<string, NativeAgentModel> = new Map();
  for (const raw of rows) {
    const row: JsonObject = object(raw);
    if (row.available === false || (provider === 'doubao' && Array.isArray(row.modes) && !row.modes.includes('work'))) continue;
    let id: unknown = provider === 'doubao' ? row.name : row.id ?? row.slug ?? row.model;
    if (provider === 'opencode' && typeof id === 'string' && typeof row.providerID === 'string' && !id.includes('/')) id = `${row.providerID}/${id}`;
    if (!validLabel(id)) continue;
    const rawEfforts: unknown = row.reasoningEfforts ?? row.supported_efforts ?? row.supportedEfforts;
    const efforts: string[] = provider === 'opencode' ? effortValues(Object.keys(object(row.variants))) : effortValues(rawEfforts);
    models.set(id, { id, name: validLabel(row.name) ? row.name : validLabel(row.label) ? row.label : validLabel(row.display_name) ? row.display_name : id,
      ...(Array.isArray(rawEfforts) || provider === 'opencode' ? { reasoningEfforts: efforts } : {}) });
  }
  if (provider === 'opencode' || provider === 'antigravity') {
    for (const line of text.split(/\r?\n/)) {
      const match: RegExpMatchArray | null = line.trim().match(provider === 'opencode' ? /^([a-z\d][\w.-]*\/[\w./:-]+)$/iu : /^([a-z\d][\w.-]+)\s{2,}(.+)$/iu);
      if (match && validLabel(match[1]) && !models.has(match[1])) models.set(match[1], { id: match[1], name: validLabel(match[2]) ? match[2] : match[1], ...(provider === 'opencode' ? { reasoningEfforts: [] } : {}) });
    }
  }
  return [...models.values()].slice(0, 256);
}

export function authenticationState(provider: LocalAgentProvider, result: NativeProcessResult): NativeAgentStatus['state'] {
  const text: string = `${result.stdout}\n${result.stderr}`;
  if (/not logged in|not authenticated|login required|authentication required|login_required/iu.test(text)) return 'login_required';
  if (provider === 'codex') return result.code === 0 ? 'ready' : 'error';
  if (provider === 'opencode') return result.code === 0 && /\b[1-9]\d*\s+(?:credentials?|environment variables?)\b/iu.test(text) ? 'ready' : result.code === 0 ? 'login_required' : 'error';
  for (const value of jsonValues(result.stdout)) {
    const status: JsonObject = object(value);
    if (status.loggedIn === true && result.code === 0) return 'ready';
    if (status.loggedIn === false || status.loginRequired === true) return 'login_required';
  }
  return 'error';
}
