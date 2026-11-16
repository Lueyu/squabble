/**
 * local-agents CLI 本地元数据读取：模型清单、推理档位、登录状态探测。
 *
 * 职责边界：只读 CLI 生成的标量元数据（settings.json/config.toml/models
 * 缓存），绝不返回凭据值；kimiCredentialEnv 只转发所选 provider 显式声明
 * 的凭据环境变量名，应用侧机密绝不外泄。
 *
 * 上下游：import node:fs/os/path、shared 接口与 process/resolver 的类型；
 * 被 native.ts、doubao.ts、events.ts 等使用（object/jsonValues 是通用工具）。
 *
 * 关键约定：模型列表统一截断到 256 条；标签类字段必须过 validLabel
 * （trim 对称、<=160 字符、无控制字符，可传更短上限）；本地文本读取上限
 * 1MiB（超限或不存在返回空串）；gemini 只对白名单的 3.x preview 模型提供
 * low/high 思考档位；antigravity 要求 agy >= 1.3.4。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  LocalAgentProvider,
  NativeAgentModel,
  NativeAgentStatus,
} from '../../shared/local-agents.interface';
import type { NativeProcessResult } from './process';
import type { NativeResolverOptions } from './resolver';

export interface JsonObject {
  [key: string]: unknown;
}
/** 仅当 value 是非数组对象时返回它，否则返回空对象（读字段防炸）。 */
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
/** 读本地文本：超过 1MiB 或读取失败一律返回空串（绝不放大文件进内存）。 */
export function readLocalText(path: string): string {
  try {
    return statSync(path).size <= 1024 * 1024 ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}
/**
 * 从文本里提取所有 JSON 值：先尝试整段 parse；失败则逐字符扫描括号配对
 * （忽略字符串字面量与转义）提取顶层 {}/[] 片段——有些 CLI 会在 JSON 前
 * 输出告示或模型 id。
 */
export function jsonValues(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    /* 有些 CLI 会在 JSON 前缀输出告示或模型 id。 */
  }
  const values: unknown[] = [];
  let start: number = -1;
  let depth: number = 0;
  let quoted: boolean = false;
  let escaped: boolean = false;
  for (let i: number = 0; i < text.length; i++) {
    const char: string = text[i];
    // 尚未进入 JSON：找到第一个 { 或 [ 才开始记录。
    if (start < 0) {
      if (char === '{' || char === '[') {
        start = i;
        depth = 1;
      }
      continue;
    }
    // 字符串字面量内：跟踪反斜杠转义，引号只在非转义时闭合。
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (--depth !== 0) continue;
      try {
        values.push(JSON.parse(text.slice(start, i + 1)));
      } catch {
        /* 跳过非 JSON 的诊断输出。 */
      }
      start = -1;
    }
  }
  return values;
}
function jsonFile(path: string): JsonObject {
  return object(jsonValues(readLocalText(path))[0]);
}
/** 标签合法性：trim 对称、长度 1..length（默认 160）、不含控制字符。 */
function validLabel(value: unknown, length: number = 160): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= length &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
/** 推理档位清洗：字符串去重（<=32 字符标签）、最多保留 16 个。 */
export function effortValues(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item: unknown): item is string => validLabel(item, 32)))].slice(
        0,
        16,
      )
    : [];
}
/** 各 provider 出厂推理档位（读不到 CLI 配置时的默认值）。 */
export const DEFAULT_EFFORTS: Record<LocalAgentProvider, string[]> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  claude: ['low', 'medium', 'high', 'max'],
  gemini: [],
  antigravity: ['low', 'medium', 'high', 'max'],
  opencode: [],
  kimi: [],
  doubao: ['low', 'medium', 'high', 'xhigh', 'max'],
};
/** 前端配置帮助文案：逐 provider 说明登录方式与模型来源（如实描述，不编造能力）。 */
const HELP: Record<LocalAgentProvider, string> = {
  codex:
    'Uses codex login and your native model configuration. Model IDs can also be entered manually; the CLI validates model/effort compatibility.',
  claude:
    'Uses Claude Code authentication. Enter a native model name or alias; effort support depends on the selected model and CLI version.',
  gemini:
    'Uses Gemini CLI credentials. Readiness checks local credentials without a paid request. Thinking overrides require an explicitly listed Gemini model; other models and automatic routing use native defaults.',
  antigravity:
    'Requires native agy >=1.3.4 with a reusable OS keyring login or API/ADC credentials. Models come from agy models. Research uses disposable settings, a read-only agent and an authentication preflight; file-only login profiles may require native keyring setup.',
  opencode:
    'Uses OpenCode provider connections. Enter provider/model; reasoning choices are the variants advertised by opencode models --verbose.',
  kimi: 'Requires current @moonshot-ai/kimi-code, not the retired Python kimi-cli. Models and supported effort levels are read from local config.toml; local credentials are checked without a paid request.',
  doubao:
    'Community doubao-cli bridge (not an official ByteDance CLI). Uses headless login and cloud Work tasks. Exact live model names are required. Tasks remain in Doubao history; cancellation calls sessions stop.',
};
/** 支持 thinking 覆盖的 Gemini 模型白名单：只有这些模型提供 low/high 档位。 */
const GEMINI_THINKING_MODELS: ReadonlySet<string> = new Set([
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
]);
export function geminiEfforts(model: string): string[] {
  return GEMINI_THINKING_MODELS.has(model) ? ['low', 'high'] : [];
}
/** antigravity 版本门槛：agy >= 1.3.4 才视为支持。 */
export function supportsAntigravity(version: string): boolean {
  const match: RegExpMatchArray | null = version.match(/\b(\d+)\.(\d+)\.(\d+)/u);
  return Boolean(
    match &&
    (Number(match[1]) > 1 ||
      (Number(match[1]) === 1 &&
        (Number(match[2]) > 3 || (Number(match[2]) === 3 && Number(match[3]) >= 4)))),
  );
}
/** 无本地配置时的兜底能力集：空模型列表 + 出厂档位 + 帮助文案。 */
export function defaultCapabilities(
  provider: LocalAgentProvider,
): Pick<NativeAgentStatus, 'models' | 'reasoningEfforts' | 'configurationHelp'> {
  return {
    models: [],
    reasoningEfforts: [...DEFAULT_EFFORTS[provider]],
    configurationHelp: HELP[provider],
  };
}

/**
 * codex/claude 的本地模型清单：
 * - claude：读 $CLAUDE_CONFIG_DIR(默认 ~/.claude)/settings.json 的 model 字段，
 *   环境变量 ANTHROPIC_MODEL 优先；无论如何都补上 opus/sonnet/haiku 三个别名。
 * - codex：读 $CODEX_HOME(默认 ~/.codex)/models_cache.json（隐藏 visibility 的
 *   条目剔除），再从 config.toml 顶部 model 字段补一个未列出的自定义模型。
 */
export function configuredModels(
  provider: 'codex' | 'claude',
  options: NativeResolverOptions,
): NativeAgentModel[] {
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const home: string = options.home ?? homedir();
  if (provider === 'claude') {
    const settings: JsonObject = jsonFile(
      join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json'),
    );
    const model: unknown = env.ANTHROPIC_MODEL ?? settings.model;
    return [...new Set([...(validLabel(model) ? [model] : []), 'opus', 'sonnet', 'haiku'])].map(
      (id: string) => ({ id, name: id }),
    );
  }
  const root: string = env.CODEX_HOME ?? join(home, '.codex');
  const cache: JsonObject = jsonFile(join(root, 'models_cache.json'));
  const models: NativeAgentModel[] = [];
  for (const raw of Array.isArray(cache.models) ? cache.models : []) {
    const row: JsonObject = object(raw);
    if (!validLabel(row.slug) || row.visibility === 'hide' || row.visibility === 'hidden') continue;
    const efforts: string[] = effortValues(
      Array.isArray(row.supported_reasoning_levels)
        ? row.supported_reasoning_levels.map((level: unknown) => object(level).effort)
        : [],
    );
    models.push({
      id: row.slug,
      name: validLabel(row.display_name) ? row.display_name : row.slug,
      ...(Array.isArray(row.supported_reasoning_levels) ? { reasoningEfforts: efforts } : {}),
    });
  }
  const config: JsonObject | undefined = tomlSections(readLocalText(join(root, 'config.toml'))).get(
    '',
  );
  // config.toml 里手工指定的 model 若不在缓存清单中，插到最前面（用户显式选择优先）。
  if (
    validLabel(config?.model) &&
    !models.some((model: NativeAgentModel) => model.id === config.model)
  )
    models.unshift({ id: config.model, name: config.model });
  return models.slice(0, 256);
}

/** 只读 CLI 生成的标量元数据，绝不返回凭据值。 */
export function tomlSections(text: string): Map<string, JsonObject> {
  const sections: Map<string, JsonObject> = new Map([['', {}]]);
  let current: JsonObject = sections.get('')!;
  for (const raw of text.split(/\r?\n/)) {
    const line: string = raw.trim();
    // [section] 头：键名支持点路径与引号包裹的段（转成点连接）。
    const header: RegExpMatchArray | null = line.match(/^\[([^\[\]]+)\]\s*(?:#.*)?$/u);
    if (header) {
      const parts: string[] = header[1].match(/"(?:\\.|[^"\\])*"|'[^']*'|[^.\s]+/gu) ?? [];
      const key: string = parts.map((part: string) => part.replace(/^['"]|['"]$/gu, '')).join('.');
      current = sections.get(key) ?? {};
      sections.set(key, current);
      continue;
    }
    // key = value 行：值先按 JSON.parse 解（数字/布尔/JSON 字符串），失败再回退单引号字面量。
    const field: RegExpMatchArray | null = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/u);
    if (!field) continue;
    const value: string = field[2].replace(/\s+#.*$/u, '').trim();
    try {
      current[field[1]] = JSON.parse(value);
    } catch {
      if (/^'[^']*'$/u.test(value)) current[field[1]] = value.slice(1, -1);
    }
  }
  return sections;
}
/**
 * kimi 凭据环境变量白名单：名字必须是合法 env 名、含 KEY/TOKEN/CREDENTIAL/
 * SECRET 语义、且不属于应用侧前缀（SQUABBLE/DATABASE/JWT/SESSION 等）——
 * 只允许 CLI 自身的凭据变量。
 */
function allowedCredentialName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) &&
    /KEY|TOKEN|CREDENTIAL|SECRET/iu.test(name) &&
    !/^(?:SQUABBLE|DATABASE|DB_|PG|MYSQL|MONGO|REDIS|SESSION|JWT|LOCAL_AGENT|AGENT_GATEWAY|SETTINGS_ENCRYPTION|PAIR|NODE|ELECTRON|BUN|LD_|DYLD|PYTHON|RUBY|PERL|DOTNET)/iu.test(
      name,
    )
  );
}
/** 只转发所选 kimi provider 在 config.toml 里显式声明的那个凭据环境变量，绝不带上应用机密。 */
export function kimiCredentialEnv(
  options: NativeResolverOptions,
  model?: string,
): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = options.env ?? process.env;
  const root: string = source.KIMI_CODE_HOME ?? join(options.home ?? homedir(), '.kimi-code');
  const sections = tomlSections(readLocalText(join(root, 'config.toml')));
  // 链式查找：模型 -> provider -> api_key_env 变量名。
  const selected: unknown = model ?? sections.get('')?.default_model;
  const provider: unknown =
    typeof selected === 'string' ? sections.get(`models.${selected}`)?.provider : undefined;
  const key: unknown =
    typeof provider === 'string' ? sections.get(`providers.${provider}`)?.api_key_env : undefined;
  return allowedCredentialName(key) && source[key]?.trim() ? { [key]: source[key] } : {};
}
/**
 * kimi 状态探测：解析 config.toml 的 models.* 段生成模型清单，并按四种凭据
 * 形态判定 configured（provider.api_key 内联 / api_key_env 环境变量 /
 * providers.*.env 里的 *_API_KEY / oauth file 凭据文件的 token），再叠加
 * KIMI_MODEL_NAME+KIMI_MODEL_API_KEY 组合。
 */
export function kimiMetadata(options: NativeResolverOptions): {
  models: NativeAgentModel[];
  state: NativeAgentStatus['state'];
  defaultModel?: string;
  thinkingDisabled: boolean;
} {
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const root: string = env.KIMI_CODE_HOME ?? join(options.home ?? homedir(), '.kimi-code');
  const sections = tomlSections(readLocalText(join(root, 'config.toml')));
  const models: NativeAgentModel[] = [];
  const defaultModel: unknown = sections.get('')?.default_model;
  const thinkingDisabled: boolean = sections.get('thinking')?.enabled === false;
  let configured: boolean = false;
  for (const [key, value] of sections) {
    if (
      !key.startsWith('models.') ||
      !validLabel(value.model) ||
      typeof value.provider !== 'string'
    )
      continue;
    const id: string = key.slice('models.'.length);
    if (!validLabel(id) || id.endsWith('.overrides')) continue;
    const provider: JsonObject = sections.get(`providers.${value.provider}`) ?? {};
    const overrides: JsonObject = sections.get(`${key}.overrides`) ?? {};
    // 思考档位只在 provider.type==='kimi' 且 thinking 未禁用时生效。
    const efforts: string[] =
      provider.type === 'kimi' && !thinkingDisabled
        ? effortValues(overrides.support_efforts ?? value.support_efforts)
        : [];
    models.push({
      id,
      name: validLabel(value.display_name) ? value.display_name : id,
      reasoningEfforts: efforts,
    });
    if (id !== defaultModel) continue;
    // 仅对默认模型做登录状态判定：四类凭据任一存在即 configured。
    if (typeof provider.api_key === 'string' && provider.api_key.trim()) configured = true;
    if (allowedCredentialName(provider.api_key_env) && env[provider.api_key_env]?.trim())
      configured = true;
    const providerEnv: JsonObject = sections.get(`providers.${value.provider}.env`) ?? {};
    if (
      Object.entries(providerEnv).some(
        ([name, secret]) => /_API_KEY$/u.test(name) && typeof secret === 'string' && secret.trim(),
      )
    )
      configured = true;
    const oauth: JsonObject =
      sections.get(`providers.${value.provider}.oauth`) ?? object(provider.oauth);
    if (
      oauth.storage === 'file' &&
      typeof oauth.key === 'string' &&
      /^[A-Za-z0-9_-]{1,160}$/u.test(oauth.key)
    ) {
      const credential: JsonObject = jsonFile(join(root, 'credentials', `${oauth.key}.json`));
      configured ||= [credential.refresh_token, credential.access_token].some(
        (token: unknown) => typeof token === 'string' && token.trim().length > 0,
      );
    }
  }
  if (env.KIMI_MODEL_NAME && env.KIMI_MODEL_API_KEY) configured = true;
  return {
    models: models.slice(0, 256),
    state: configured ? 'ready' : 'login_required',
    defaultModel: typeof defaultModel === 'string' ? defaultModel : undefined,
    thinkingDisabled,
  };
}
/**
 * gemini 状态探测：settings.json 的 security.auth.selectedType 决定判定分支
 * （oauth-personal 查 oauth_creds.json 的 token；vertex-ai 查 API key 或
 * GOOGLE_APPLICATION_CREDENTIALS；其余查 API key）。模型清单 = modelConfigs
 * aliases + thinking 白名单 + settings.model.name，全部按 validLabel 过滤。
 */
export function geminiMetadata(options: NativeResolverOptions): {
  state: NativeAgentStatus['state'];
  models: NativeAgentModel[];
} {
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const root: string = join(env.GEMINI_CLI_HOME ?? options.home ?? homedir(), '.gemini');
  const settings: JsonObject = jsonFile(join(root, 'settings.json'));
  const selected: unknown = object(object(settings.security).auth).selectedType;
  const oauth: JsonObject = jsonFile(join(root, 'oauth_creds.json'));
  const api: boolean = Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  const configured: boolean =
    selected === 'oauth-personal'
      ? Boolean(oauth.refresh_token || oauth.access_token)
      : selected === 'vertex-ai'
        ? api ||
          Boolean(
            env.GOOGLE_APPLICATION_CREDENTIALS && readLocalText(env.GOOGLE_APPLICATION_CREDENTIALS),
          )
        : api;
  const ids: string[] = [
    ...Object.keys(object(object(settings.modelConfigs).aliases)),
    ...GEMINI_THINKING_MODELS,
  ];
  const model: unknown = object(settings.model).name;
  if (validLabel(model)) ids.unshift(model);
  return {
    state: configured ? 'ready' : 'login_required',
    models: [...new Set(ids)]
      .filter((id: string) => validLabel(id))
      .slice(0, 256)
      .map((id: string) => ({ id, name: id, reasoningEfforts: geminiEfforts(id) })),
  };
}
/**
 * 解析 CLI `models` 命令的输出（JSON 或纯文本）：
 * - JSON 路径：数组/对象展开，剔除 available=false 与 doubao 非 work 模式；
 *   opencode 自动补 providerID/ 前缀；id 取 id/slug/model（doubao 用 name）；
 *   name 取 name/label/display_name 兜底。
 * - 纯文本路径（opencode/antigravity）：逐行匹配 `id`（opencode 要求含 `/`，
 *   antigravity 要求 id 后两个以上空格接显示名）。
 * 统一按 Map 去重并截断到 256 条。
 */
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
    if (
      row.available === false ||
      (provider === 'doubao' && Array.isArray(row.modes) && !row.modes.includes('work'))
    )
      continue;
    let id: unknown = provider === 'doubao' ? row.name : (row.id ?? row.slug ?? row.model);
    if (
      provider === 'opencode' &&
      typeof id === 'string' &&
      typeof row.providerID === 'string' &&
      !id.includes('/')
    )
      id = `${row.providerID}/${id}`;
    if (!validLabel(id)) continue;
    const rawEfforts: unknown =
      row.reasoningEfforts ?? row.supported_efforts ?? row.supportedEfforts;
    const efforts: string[] =
      provider === 'opencode'
        ? effortValues(Object.keys(object(row.variants)))
        : effortValues(rawEfforts);
    models.set(id, {
      id,
      name: validLabel(row.name)
        ? row.name
        : validLabel(row.label)
          ? row.label
          : validLabel(row.display_name)
            ? row.display_name
            : id,
      ...(Array.isArray(rawEfforts) || provider === 'opencode'
        ? { reasoningEfforts: efforts }
        : {}),
    });
  }
  if (provider === 'opencode' || provider === 'antigravity') {
    for (const line of text.split(/\r?\n/)) {
      const match: RegExpMatchArray | null = line
        .trim()
        .match(
          provider === 'opencode'
            ? /^([a-z\d][\w.-]*\/[\w./:-]+)$/iu
            : /^([a-z\d][\w.-]+)\s{2,}(.+)$/iu,
        );
      if (match && validLabel(match[1]) && !models.has(match[1]))
        models.set(match[1], {
          id: match[1],
          name: validLabel(match[2]) ? match[2] : match[1],
          ...(provider === 'opencode' ? { reasoningEfforts: [] } : {}),
        });
    }
  }
  return [...models.values()].slice(0, 256);
}
/**
 * 登录状态判定：先看 stdout+stderr 是否含 login_required 类文案；codex 直接
 * 以退出码为准；opencode 要求退出码 0 且输出里有 "N credentials/environment
 * variables" 计数；其余 provider 解析 stdout JSON 的 loggedIn/loginRequired。
 */
export function authenticationState(
  provider: LocalAgentProvider,
  result: NativeProcessResult,
): NativeAgentStatus['state'] {
  const text: string = `${result.stdout}\n${result.stderr}`;
  if (
    /not logged in|not authenticated|login required|authentication required|login_required/iu.test(
      text,
    )
  )
    return 'login_required';
  if (provider === 'codex') return result.code === 0 ? 'ready' : 'error';
  if (provider === 'opencode')
    return result.code === 0 &&
      /\b[1-9]\d*\s+(?:credentials?|environment variables?)\b/iu.test(text)
      ? 'ready'
      : result.code === 0
        ? 'login_required'
        : 'error';
  for (const value of jsonValues(result.stdout)) {
    const status: JsonObject = object(value);
    if (status.loggedIn === true && result.code === 0) return 'ready';
    if (status.loggedIn === false || status.loginRequired === true) return 'login_required';
  }
  return 'error';
}
