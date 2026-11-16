/**
 * local-agents 可执行文件定位器：把 provider 名解析成可 spawn 的启动命令。
 *
 * 职责边界：只做"找路径 + 定前缀参数"，不执行任何命令；登录子命令见
 * login.ts，进程执行见 process.ts。
 *
 * 上下游：import node:fs/os/path 与 shared 接口；被 native.ts、login.ts、
 * research.ts 调用。
 *
 * 关键约定：PATH 里只接受绝对路径目录（空 PATH 项按 cwd 处理，绝不从任意
 * 项目目录发现工具）；Windows 不执行 .cmd/.ps1 包装脚本，改为读 npm 包
 * package.json 的 bin 字段直接定位真实入口（.exe 直跑，JS/shebang 用独立
 * node 跑）；桌面主进程里 process.execPath 是 Electron，绝不用它跑 JS shim。
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';

/** 一次解析结果：可执行文件 + 需要放在它前面的前缀参数（如 node script.js）。 */
export interface NativeLaunch {
  executable: string;
  prefixArgs: string[];
}
export interface NativeResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  nodeExecutable?: string;
  fallbackDirectories?: string[];
}

/** provider -> npm 包名（npmEntry 用它校验 package.json 归属）。 */
const PACKAGES: Partial<Record<LocalAgentProvider, string>> = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  gemini: '@google/gemini-cli',
  opencode: 'opencode-ai',
  kimi: '@moonshot-ai/kimi-code',
  doubao: 'doubao-cli',
};
/** provider -> CLI 二进制名（antigravity 的 CLI 叫 agy）。 */
const BIN_NAMES: Record<LocalAgentProvider, string> = {
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
  antigravity: 'agy',
  opencode: 'opencode',
  kimi: 'kimi',
  doubao: 'doubao',
};

/** 存在且是文件，并按需校验可执行位（Windows 上不做 X_OK 校验）。 */
function isFile(path: string, executable: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, executable ? constants.X_OK : constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 列出目录下所有子目录的绝对路径；读不了就当空处理。 */
function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

/** 读文件头 256 字节判断是否是 `#!... node` 的 node 脚本 shebang。 */
function hasNodeShebang(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const prefix: Buffer = Buffer.alloc(256);
    const length: number = readSync(fd, prefix, 0, prefix.length, 0);
    return /^#![^\r\n]*\bnode(?:\s|$)/.test(prefix.subarray(0, length).toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 兜底搜索目录：用户家目录下的常见安装位 + 平台相关的系统目录。 */
function fallbackDirs(options: NativeResolverOptions): string[] {
  if (options.fallbackDirectories) return options.fallbackDirectories;
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const home: string = options.home ?? homedir();
  const platform: NodeJS.Platform = options.platform ?? process.platform;
  const common: string[] = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.antigravity', 'bin'),
    join(home, '.kimi-code', 'bin'),
    join(home, '.bun', 'bin'),
  ];
  if (platform === 'win32') {
    if (env.APPDATA) common.push(join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) {
      common.push(join(env.LOCALAPPDATA, 'npm'), join(env.LOCALAPPDATA, 'agy', 'bin'));
      // OpenAI 官方桌面应用也把带版本号的本地 CLI 放在这里。
      const versions: string[] = directories(join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'));
      versions.sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
      common.push(...versions);
    }
  } else {
    common.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      join(home, '.fnm', 'aliases', 'default', 'bin'),
    );
    common.push(
      ...directories(join(home, '.nvm', 'versions', 'node')).map((path) => join(path, 'bin')),
    );
  }
  return common;
}

/** 解析 PATH：去掉首尾引号，只保留非空且为绝对路径的目录项。 */
function pathDirs(options: NativeResolverOptions): string[] {
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const pathValue: string = env.PATH ?? env.Path ?? '';
  const delimiter: string = (options.platform ?? process.platform) === 'win32' ? ';' : ':';
  // PATH 里的空项在操作系统语义下表示 cwd。绝不在任意项目目录里发现工具。
  return pathValue
    .split(delimiter)
    .map((path) => path.replace(/^"|"$/g, ''))
    .filter((path) => path && isAbsolute(path));
}

/** 定位 node 可执行文件：显式指定 > process.execPath（非 Electron）> PATH/兜底目录。 */
function resolveNode(options: NativeResolverOptions): string | null {
  if (options.nodeExecutable && isFile(options.nodeExecutable, false))
    return options.nodeExecutable;
  // 桌面主进程里 process.execPath 是 Electron；绝不用它运行 JS shim。
  if (!process.versions.electron && isFile(process.execPath, false)) return process.execPath;
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const windows: boolean = (options.platform ?? process.platform) === 'win32';
  const paths: string[] = [...pathDirs(options), ...fallbackDirs(options)];
  if (windows) paths.push(join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'));
  for (const path of paths) {
    const candidate: string = join(path, windows ? 'node.exe' : 'node');
    if (isFile(candidate, !windows)) return candidate;
  }
  return null;
}

/** 只解析包声明过的 bin；绝不执行任意的 .cmd/.ps1 包装脚本内容。 */
function npmEntry(
  provider: LocalAgentProvider,
  binDir: string,
  options: NativeResolverOptions,
): NativeLaunch | null {
  const packageName: string | undefined = PACKAGES[provider];
  if (!packageName) return null;
  // npm 全局两种布局：Windows <bin>/node_modules/<pkg>，Unix <bin>/../lib/node_modules/<pkg>。
  for (const packageRoot of [
    join(binDir, 'node_modules', packageName),
    join(binDir, '..', 'lib', 'node_modules', packageName),
  ]) {
    try {
      const manifest: { name?: string; bin?: string | Record<string, string> } = JSON.parse(
        readFileSync(join(packageRoot, 'package.json'), 'utf8'),
      );
      if (manifest.name !== PACKAGES[provider]) continue;
      const entry: string | undefined =
        typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[provider];
      if (!entry || isAbsolute(entry)) continue;
      const script: string = resolve(packageRoot, entry);
      // 入口必须落在包目录内部（防 path traversal）。
      const within: string = relative(resolve(packageRoot), script);
      if (
        within === '..' ||
        within.startsWith(`..${sep}`) ||
        isAbsolute(within) ||
        !isFile(script, false)
      )
        continue;
      if (/\.exe$/i.test(script)) return { executable: script, prefixArgs: [] };
      if (/\.(?:c|m)?js$/i.test(script) || hasNodeShebang(script)) {
        const node: string | null = resolveNode(options);
        if (node) return { executable: node, prefixArgs: [script] };
      }
    } catch {
      /* 不是受支持的 npm 安装形态，继续试下一个位置。 */
    }
  }
  return null;
}

/**
 * 主入口：按 PATH -> 兜底目录的顺序找 provider 的二进制。POSIX 上如果是
 * node 脚本（shebang）则改用真实 node 执行；Windows 上只认 .exe 直跑，
 * 遇到 .cmd/.ps1 包装则回退到 npmEntry 读包元数据。
 */
export function resolveNativeCommand(
  provider: LocalAgentProvider,
  options: NativeResolverOptions = {},
): NativeLaunch | null {
  if (!Object.hasOwn(BIN_NAMES, provider)) throw new Error('NATIVE_AGENT_UNSUPPORTED');
  const bin: string = BIN_NAMES[provider];
  const windows: boolean = (options.platform ?? process.platform) === 'win32';
  const search: string[] = [...new Set([...pathDirs(options), ...fallbackDirs(options)])];
  for (const directory of search) {
    const executable: string = resolve(directory, windows ? `${bin}.exe` : bin);
    if (isFile(executable, !windows)) {
      if (!windows) {
        try {
          realpathSync(executable);
        } catch {
          continue;
        }
        if (hasNodeShebang(executable)) {
          const npm: NativeLaunch | null = npmEntry(provider, directory, options);
          if (npm) return npm;
          const node: string | null = resolveNode(options);
          if (!node) continue;
          return { executable: node, prefixArgs: [realpathSync(executable)] };
        }
      }
      return { executable, prefixArgs: [] };
    }
    if (
      windows &&
      [`.cmd`, `.ps1`, ''].some((extension) => existsSync(join(directory, bin + extension)))
    ) {
      const resolved: NativeLaunch | null = npmEntry(provider, directory, options);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** 按固定名字定位终端程序，沿用同一套"非 shell PATH"策略。 */
export function resolveTerminal(name: string, options: NativeResolverOptions = {}): string | null {
  for (const directory of pathDirs(options)) {
    const candidate: string = join(directory, name);
    if (isFile(candidate, (options.platform ?? process.platform) !== 'win32')) return candidate;
  }
  return null;
}
