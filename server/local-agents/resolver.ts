import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';

export interface NativeLaunch { executable: string; prefixArgs: string[] }
export interface NativeResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  nodeExecutable?: string;
  fallbackDirectories?: string[];
}

const PACKAGES: Partial<Record<LocalAgentProvider, string>> = {
  codex: '@openai/codex', claude: '@anthropic-ai/claude-code', gemini: '@google/gemini-cli',
  opencode: 'opencode-ai', kimi: '@moonshot-ai/kimi-code', doubao: 'doubao-cli',
};
const BIN_NAMES: Record<LocalAgentProvider, string> = {
  codex: 'codex', claude: 'claude', gemini: 'gemini', antigravity: 'agy', opencode: 'opencode', kimi: 'kimi', doubao: 'doubao',
};

function isFile(path: string, executable: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, executable ? constants.X_OK : constants.F_OK);
    return true;
  } catch { return false; }
}

function directories(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name)); }
  catch { return []; }
}

function hasNodeShebang(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const prefix: Buffer = Buffer.alloc(256);
    const length: number = readSync(fd, prefix, 0, prefix.length, 0);
    return /^#![^\r\n]*\bnode(?:\s|$)/.test(prefix.subarray(0, length).toString('utf8'));
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function fallbackDirs(options: NativeResolverOptions): string[] {
  if (options.fallbackDirectories) return options.fallbackDirectories;
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const home: string = options.home ?? homedir();
  const platform: NodeJS.Platform = options.platform ?? process.platform;
  const common: string[] = [join(home, '.local', 'bin'), join(home, '.claude', 'bin'), join(home, '.volta', 'bin'),
    join(home, '.opencode', 'bin'), join(home, '.antigravity', 'bin'), join(home, '.kimi-code', 'bin'), join(home, '.bun', 'bin')];
  if (platform === 'win32') {
    if (env.APPDATA) common.push(join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) {
      common.push(join(env.LOCALAPPDATA, 'npm'), join(env.LOCALAPPDATA, 'agy', 'bin'));
      // The official desktop app also exposes a versioned native CLI here.
      const versions: string[] = directories(join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'));
      versions.sort((a, b) => {
        try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
      });
      common.push(...versions);
    }
  } else {
    common.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(home, '.fnm', 'aliases', 'default', 'bin'));
    common.push(...directories(join(home, '.nvm', 'versions', 'node')).map((path) => join(path, 'bin')));
  }
  return common;
}

function pathDirs(options: NativeResolverOptions): string[] {
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  const pathValue: string = env.PATH ?? env.Path ?? '';
  const delimiter: string = (options.platform ?? process.platform) === 'win32' ? ';' : ':';
  // Empty PATH entries mean cwd to the OS. Do not discover tools in an arbitrary project.
  return pathValue.split(delimiter).map((path) => path.replace(/^"|"$/g, '')).filter((path) => path && isAbsolute(path));
}

function resolveNode(options: NativeResolverOptions): string | null {
  if (options.nodeExecutable && isFile(options.nodeExecutable, false)) return options.nodeExecutable;
  // process.execPath is Electron in the desktop main process; never run a JS shim with it.
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

/** Resolve only the package's declared bin; never execute arbitrary .cmd/.ps1 wrapper text. */
function npmEntry(provider: LocalAgentProvider, binDir: string, options: NativeResolverOptions): NativeLaunch | null {
  const packageName: string | undefined = PACKAGES[provider];
  if (!packageName) return null;
  for (const packageRoot of [join(binDir, 'node_modules', packageName), join(binDir, '..', 'lib', 'node_modules', packageName)]) {
    try {
      const manifest: { name?: string; bin?: string | Record<string, string> } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      if (manifest.name !== PACKAGES[provider]) continue;
      const entry: string | undefined = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[provider];
      if (!entry || isAbsolute(entry)) continue;
      const script: string = resolve(packageRoot, entry);
      const within: string = relative(resolve(packageRoot), script);
      if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) || !isFile(script, false)) continue;
      if (/\.exe$/i.test(script)) return { executable: script, prefixArgs: [] };
      if (/\.(?:c|m)?js$/i.test(script) || hasNodeShebang(script)) {
        const node: string | null = resolveNode(options);
        if (node) return { executable: node, prefixArgs: [script] };
      }
    } catch { /* Not a supported npm installation. */ }
  }
  return null;
}

export function resolveNativeCommand(provider: LocalAgentProvider, options: NativeResolverOptions = {}): NativeLaunch | null {
  if (!Object.hasOwn(BIN_NAMES, provider)) throw new Error('NATIVE_AGENT_UNSUPPORTED');
  const bin: string = BIN_NAMES[provider];
  const windows: boolean = (options.platform ?? process.platform) === 'win32';
  const search: string[] = [...new Set([...pathDirs(options), ...fallbackDirs(options)])];
  for (const directory of search) {
    const executable: string = resolve(directory, windows ? `${bin}.exe` : bin);
    if (isFile(executable, !windows)) {
      if (!windows) {
        try { realpathSync(executable); } catch { continue; }
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
    if (windows && [`.cmd`, `.ps1`, ''].some((extension) => existsSync(join(directory, bin + extension)))) {
      const resolved: NativeLaunch | null = npmEntry(provider, directory, options);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Resolve a terminal by its fixed name, using the same non-shell PATH policy. */
export function resolveTerminal(name: string, options: NativeResolverOptions = {}): string | null {
  for (const directory of pathDirs(options)) {
    const candidate: string = join(directory, name);
    if (isFile(candidate, (options.platform ?? process.platform) !== 'win32')) return candidate;
  }
  return null;
}
