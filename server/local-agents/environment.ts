/**
 * local-agents 环境变量过滤：构造 Python 桥接子进程继承的环境。
 *
 * 职责边界：只做"环境白名单拷贝"；不负责进程启动/回收（见 process.ts），
 * 也不注入任何应用凭据。
 *
 * 上下游：被 process.ts 等启动子进程的模块调用；自身无 import。
 *
 * 关键约定：三类白名单正则（system 通用系统变量 / provider 三方 CLI 凭据 /
 * additional 其他 CLI 变量）取交集之外的值一律丢弃——子进程拿到的是用户的
 * CLI 身份，绝不是本应用的数据库连接串或配对凭据。
 */

/** 保留用户的 CLI 身份环境，绝不传递本应用的数据库或配对凭据。 */
export function nativeChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const system: RegExp =
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|TEMP|TMP|TMPDIR|USER|USERNAME|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|SHELL|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY|XDG_(DATA_HOME|CONFIG_HOME|CACHE_HOME|RUNTIME_DIR|CURRENT_DESKTOP|SESSION_TYPE)|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE)$/i;
  const provider: RegExp =
    /^(CODEX_(HOME|API_KEY|ACCESS_TOKEN)|OPENAI_(API_KEY|BASE_URL|API_BASE|ORG_ID|PROJECT_ID)|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|DEFAULT_[A-Z_]+_MODEL))$/;
  const additional: RegExp =
    /^(GEMINI_(API_KEY|CLI_HOME)|GOOGLE_(API_KEY|APPLICATION_CREDENTIALS|CLOUD_PROJECT|CLOUD_LOCATION|GENAI_USE_VERTEXAI|GENAI_USE_GCA|GEMINI_BASE_URL)|AGY_ADC_AUTH|OPENCODE_(API_KEY|CONFIG|CONFIG_DIR)|KIMI_(CODE_HOME|SHELL_PATH|MODEL_(NAME|API_KEY|BASE_URL|PROVIDER_TYPE|CAPABILITIES|MAX_CONTEXT_SIZE|THINKING_EFFORT)|WEB_(SEARCH|FETCH)_(BASE_URL|API_KEY))|DOUBAO_(CLI_CONFIG_DIR|HEADLESS_COOKIE))$/;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (system.test(key) || provider.test(key) || additional.test(key)))
      result[key] = value;
  }
  return result;
}
