/** Preserve the user's CLI identity, never the application's database or pairing credentials. */
export function nativeChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const system: RegExp = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|TEMP|TMP|TMPDIR|USER|USERNAME|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|SHELL|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY|XDG_(DATA_HOME|CONFIG_HOME|CACHE_HOME|RUNTIME_DIR|CURRENT_DESKTOP|SESSION_TYPE)|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE)$/i;
  const provider: RegExp = /^(CODEX_(HOME|API_KEY|ACCESS_TOKEN)|OPENAI_(API_KEY|BASE_URL|API_BASE|ORG_ID|PROJECT_ID)|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|DEFAULT_[A-Z_]+_MODEL))$/;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (system.test(key) || provider.test(key))) result[key] = value;
  }
  return result;
}
