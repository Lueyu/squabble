/**
 * local-agents 调用参数构造：按 provider 把 prompt/模型/推理档位编成
 * 一次性的 CLI 调用（args/input/env）。
 *
 * 职责边界：只产出 ResearchInvocation（参数、stdin、环境变量）与必要的
 * 一次性配置文件；不执行进程（process.ts）、不做隔离校验（tool-config.ts）。
 *
 * 上下游：import node:fs/promises、node:os、node:path、shared 接口与
 * metadata 的模型元数据工具；被 native.ts 调用。
 *
 * 关键约定：所有覆盖都是 invocation 作用域——绝不改用户原生 CLI 设置；
 * 一次性配置文件用 privateFile 写（目录 0o700、文件 0o600、flag 'wx' 不
 * 覆盖既有文件）；模型 id 上限 160 字符、档位 32 字符且不得含控制字符；
 * 档位合法性按各 provider 实际清单校验（codex/gemini 读本地缓存，kimi/
 * opencode/antigravity 探测 CLI），不匹配抛
 * NATIVE_AGENT_CONFIGURATION_UNSUPPORTED。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  LocalAgentProvider,
  NativeAgentConfiguration,
  NativeAgentModel,
} from '../../shared/local-agents.interface';
import {
  configuredModels,
  DEFAULT_EFFORTS,
  geminiEfforts,
  jsonValues,
  kimiMetadata,
  object,
  parseModels,
  readLocalText,
  supportsAntigravity,
} from './metadata';
import type { NativeProcessResult } from './process';
import type { NativeResolverOptions } from './resolver';

export interface ResearchInvocation {
  args: string[];
  input: string;
  env: NodeJS.ProcessEnv;
}
/** 短命探针签名：探测类命令（--version/doctor/models）的统一入口。 */
export type NativeProbe = (
  args: string[],
  context?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<NativeProcessResult>;
/** 一次性研究 agent 的公共指令：只许用提供的只读工具，产出完整报告。 */
const RESEARCH_INSTRUCTIONS: string =
  'Research the user request with sources. Return a complete report. Use only the provided read and web research tools.';

/** 清洗用户配置：model<=160 字符、reasoningEffort<=32 字符，均不得为空或含控制字符。 */
export function normalizedConfiguration(
  settings: NativeAgentConfiguration | undefined,
): NativeAgentConfiguration {
  if (!settings) return {};
  const result: NativeAgentConfiguration = {};
  for (const key of ['model', 'reasoningEffort'] as const) {
    const value: unknown = settings[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.trim().length > (key === 'model' ? 160 : 32) ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      throw new Error('NATIVE_AGENT_INVALID_CONFIGURATION');
    result[key] = value.trim();
  }
  return result;
}

/** 写一次性私有文件：父目录 0o700、文件 0o600；flag 'wx' 保证不覆盖既有文件。 */
async function privateFile(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
}

/** 所有覆盖都限定在本次调用作用域内；绝不修改用户的原生 CLI 设置。 */
export async function researchInvocation(
  provider: LocalAgentProvider,
  prompt: string,
  settings: NativeAgentConfiguration,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: NativeResolverOptions,
  probe: NativeProbe,
): Promise<ResearchInvocation> {
  const env: NodeJS.ProcessEnv = { ...environment };
  const model: string | undefined = settings.model;
  const effort: string | undefined = settings.reasoningEffort;
  // 先按 provider 能读到的本地清单预校验档位（opencode/kimi 留给后续分支探测）。
  const cachedEfforts: string[] | undefined =
    provider === 'codex'
      ? configuredModels('codex', options).find((row: NativeAgentModel) => row.id === model)
          ?.reasoningEfforts
      : provider === 'gemini'
        ? geminiEfforts(model ?? '')
        : undefined;
  if (
    effort &&
    !['opencode', 'kimi'].includes(provider) &&
    !(cachedEfforts ?? DEFAULT_EFFORTS[provider]).includes(effort)
  ) {
    throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
  }
  const modelArgs: string[] = model ? ['--model', model] : [];
  if (provider === 'codex')
    return {
      env,
      input: prompt,
      args: [
        // 只读沙箱 + 一次性配置 + 禁止任何审批交互；prompt 走 stdin（'-'）。
        '--search',
        '--ask-for-approval',
        'never',
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--skip-git-repo-check',
        ...modelArgs,
        ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
        '-',
      ],
    };
  if (provider === 'claude')
    return {
      env,
      input: prompt,
      args: [
        // 打印模式 + 流式 JSON；工具/许可收口到 5 个只读工具；空白 MCP 配置
        // 占位（注入工具时会替换它）；禁 hooks 与斜杠命令。
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        ...modelArgs,
        ...(effort ? ['--effort', effort] : []),
        '--tools',
        'WebSearch,WebFetch,Read,Glob,Grep',
        '--allowedTools',
        'WebSearch,WebFetch,Read,Glob,Grep',
        '--permission-mode',
        'dontAsk',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--disable-slash-commands',
        '--settings',
        '{"disableAllHooks":true}',
      ],
    };
  if (provider === 'gemini') {
    // gemini 的思考档位绑定在白名单模型上：无模型或不在清单即拒绝。
    if (effort && (!model || !geminiEfforts(model).includes(effort))) {
      throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
    }
    const tools: string[] = [
      'google_web_search',
      'web_fetch',
      'read_file',
      'read_many_files',
      'list_directory',
      'glob',
      'grep_search',
    ];
    // 一次性系统设置：显式列全 allowed 工具、关 hooks、禁扩展/MCP/skills。
    const configPath: string = join(cwd, '.squabble', 'gemini-settings.json');
    await privateFile(
      configPath,
      JSON.stringify({
        tools: { core: tools, allowed: tools, discoveryCommand: '', callCommand: '' },
        hooksConfig: { enabled: false },
        admin: {
          extensions: { enabled: false },
          mcp: { enabled: false },
          skills: { enabled: false },
        },
        ...(effort
          ? {
              // 思考档位走 modelConfigs.overrides 的 thinkingLevel（大写）。
              modelConfigs: {
                overrides: [
                  {
                    match: { model },
                    modelConfig: {
                      generateContentConfig: {
                        thinkingConfig: {
                          thinkingLevel: effort.toUpperCase(),
                          includeThoughts: false,
                        },
                      },
                    },
                  },
                ],
              },
            }
          : {}),
      }),
    );
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configPath;
    return {
      env,
      input: prompt,
      args: ['--output-format', 'stream-json', '--approval-mode', 'default', ...modelArgs],
    };
  }
  if (provider === 'antigravity') {
    // 版本门槛先行：agy < 1.3.4 直接拒绝。
    const version = await probe(['--version']);
    if (version.code !== 0 || !supportsAntigravity(version.stdout))
      throw new Error('NATIVE_AGENT_VERSION_UNSUPPORTED');
    if (model && effort) {
      // 档位以 CLI 实时 models 输出为准。
      const models = await probe(['--output-format', 'json', 'models']);
      const supported = parseModels('antigravity', models.stdout).find(
        (row: NativeAgentModel) => row.id === model,
      )?.reasoningEfforts;
      if (supported && !supported.includes(effort))
        throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
    }
    // 一次性 gemini_dir：复用用户保存的身份字段（模型/供应商/gcp/自定义模型），
    // 但权限收口为"只读 URL + 只读文件工具"，命令/写入/MCP 全部 deny。
    const geminiDir: string = join(cwd, '.squabble', 'agy');
    const accountData: string = join(options.home ?? homedir(), '.gemini', 'antigravity-cli');
    const saved = object(jsonValues(readLocalText(join(accountData, 'settings.json')))[0]);
    const identity: Record<string, unknown> = {};
    for (const key of ['model', 'modelProvider', 'gcp', 'customModelsConfig'])
      if (saved[key] !== undefined) identity[key] = saved[key];
    await privateFile(
      join(geminiDir, 'antigravity-cli', 'settings.json'),
      JSON.stringify({
        ...identity,
        toolPermission: 'request-review',
        allowNonWorkspaceAccess: false,
        enableTerminalSandbox: true,
        trustedWorkspaces: [cwd],
        permissions: {
          allow: ['read_url(*)'],
          deny: ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'mcp(*)', 'execute_url(*)'],
        },
      }),
    );
    // 空 MCP 配置：会话内不允许任何 MCP server。
    await privateFile(join(geminiDir, 'config', 'mcp_config.json'), '{"mcpServers":{}}');
    // 一次性 agent 定义：只挂 6 个只读工具，禁止命令执行与 MCP 继承。
    await privateFile(
      join(geminiDir, 'config', 'agents', 'squabble-research', 'agent.md'),
      [
        '---',
        'name: squabble-research',
        'description: Read-only financial research',
        'mainAgent: true',
        'subagent: false',
        'commandExecutionPolicy: off',
        'inheritMcp: false',
        'tools:',
        ...[
          'view_file',
          'list_dir',
          'grep_search',
          'find_by_name',
          'read_url_content',
          'search_web',
        ].map((tool: string) => `  - ${tool}`),
        '---',
        RESEARCH_INSTRUCTIONS,
      ].join('\n'),
    );
    env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
    // OS keyring 身份跟随未改动的系统用户；设置与会话数据只属于本次调用。
    const profileArgs: string[] = [`--gemini_dir=${geminiDir}`, '--app_data_dir=antigravity-cli'];
    // 登录预检：/usage 探针失败即视为需要登录。
    const auth = await probe([...profileArgs, '-p', '/usage', '--output-format', 'json']);
    if (auth.code !== 0) throw new Error('NATIVE_AGENT_LOGIN_REQUIRED');
    return {
      env,
      // prompt 以 stream-json 事件帧写入 stdin（外层补换行）。
      input: `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
      args: [
        ...profileArgs,
        '--agent',
        'squabble-research',
        '--sandbox',
        '--disable-slash-commands',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        ...modelArgs,
        ...(effort ? ['--effort', effort] : []),
      ],
    };
  }
  if (provider === 'opencode') {
    // 档位以 `models --verbose` 的 variants 为准，模型不存在即拒绝。
    if (effort) {
      const catalog: NativeProcessResult = await probe(['models', '--verbose']);
      const selected: NativeAgentModel | undefined = parseModels('opencode', catalog.stdout).find(
        (row: NativeAgentModel) => row.id === model,
      );
      if (catalog.code !== 0 || !selected?.reasoningEfforts?.includes(effort))
        throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
    }
    // 权限矩阵：默认全 deny，仅放行 5 类只读工具；同一份矩阵同时下发到
    // OPENCODE_PERMISSION 与内联 config（squabble-research agent）。
    const permissions = {
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
    };
    env.OPENCODE_PERMISSION = JSON.stringify(permissions);
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      permission: permissions,
      agent: {
        'squabble-research': {
          description: 'Read-only research',
          mode: 'primary',
          prompt: RESEARCH_INSTRUCTIONS,
          permission: permissions,
        },
      },
    });
    return {
      env,
      input: prompt,
      args: [
        'run',
        '--format',
        'json',
        '--agent',
        'squabble-research',
        ...modelArgs,
        ...(effort ? ['--variant', effort] : []),
      ],
    };
  }
  if (provider === 'kimi') {
    // doctor config 探活即版本门槛。
    const doctor: NativeProcessResult = await probe(['doctor', 'config']);
    if (doctor.code !== 0) throw new Error('NATIVE_AGENT_VERSION_UNSUPPORTED');
    if (effort) {
      // 档位来自本地 config.toml 的 support_efforts（含 overrides）。
      const metadata = kimiMetadata(options);
      const selected = metadata.models.find(
        (row: NativeAgentModel) => row.id === (model ?? metadata.defaultModel),
      );
      if (!selected?.reasoningEfforts?.includes(effort))
        throw new Error('NATIVE_AGENT_CONFIGURATION_UNSUPPORTED');
      env.KIMI_MODEL_THINKING_EFFORT = effort;
    }
    // 一次性 agent 文件：只挂 5 个只读工具，无子 agent。
    const agent: string = join(cwd, '.squabble', 'kimi-research.md');
    await privateFile(
      agent,
      [
        '---',
        'name: squabble-research',
        'description: Read-only financial research',
        'tools: [Read, Glob, Grep, WebSearch, WebFetch]',
        'subagents: []',
        '---',
        RESEARCH_INSTRUCTIONS,
      ].join('\n'),
    );
    // 关自动更新/后台保活/cron：研究调用必须是一次性的、无副作用。
    env.KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT = 'false';
    env.KIMI_CODE_NO_AUTO_UPDATE = '1';
    env.KIMI_DISABLE_CRON = '1';
    // 原生 Kimi 把 prompt 当单个 argv 值；不经过任何 shell。
    return {
      env,
      input: '',
      args: [
        '--prompt',
        prompt,
        '--output-format',
        'stream-json',
        '--agent-file',
        agent,
        ...modelArgs,
      ],
    };
  }
  // doubao（默认分支）：远端 Work 会话，prompt 放在 `--` 之后的单个 argv。
  return {
    env,
    input: '',
    args: [
      'headless',
      'sessions',
      'create',
      '--mode',
      'work',
      '--runtime',
      'cloud',
      '--json',
      ...modelArgs,
      ...(effort ? ['--reasoning', effort] : []),
      '--',
      prompt,
    ],
  };
}
