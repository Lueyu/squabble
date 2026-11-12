import type { FailureStage, SafeFailure } from '../../shared/research-execution.interface';
import { nativeFailureCode } from '../modules/local-agents/local-agents.types';
import { COMPANION_FAILURE_CODES } from '../../shared/local-agents.interface';

/** Accept only the fixed failure vocabulary and operational fields across adapters. */
export function safeFailureValue(value: unknown): SafeFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (!COMPANION_FAILURE_CODES.includes(row.code as typeof COMPANION_FAILURE_CODES[number])
    || !['preflight', 'dispatch', 'runtime', 'parse'].includes(String(row.stage))
    || !Array.isArray(row.recoveries) || row.recoveries.length > 4
    || row.recoveries.some(item => !['check_existing', 'reparse_existing', 'retry_member', 'fix_configuration'].includes(String(item)))) return;
  const result: SafeFailure = { code: String(row.code), stage: row.stage as SafeFailure['stage'], recoveries: [...row.recoveries] as SafeFailure['recoveries'] };
  for (const key of ['fieldPath', 'expectedType', 'actualType'] as const) {
    if (typeof row[key] === 'string' && /^[A-Za-z0-9_. ()–-]{1,160}$/u.test(row[key])) result[key] = row[key];
  }
  if (Number.isSafeInteger(row.exitCode) && Number(row.exitCode) >= -2147483648 && Number(row.exitCode) <= 4294967295) result.exitCode = Number(row.exitCode);
  for (const key of ['outputBytes', 'stderrBytes'] as const) if (Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) result[key] = Number(row[key]);
  if (typeof row.terminalEvent === 'boolean') result.terminalEvent = row.terminalEvent;
  return result;
}

export function safeExecutionFailure(error: unknown, stage: FailureStage = 'runtime'): SafeFailure {
  const row = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const preserved = safeFailureValue(row.failure);
  if (preserved) return preserved;
  const message = error instanceof Error ? error.message : '';
  const a2aUnknown = ['A2A_DISPATCH_UNKNOWN', 'A2A_TIMEOUT', 'A2A_STATUS_UNKNOWN', 'A2A_CANCEL_UNKNOWN', 'A2A_CANCEL_PENDING', 'A2A_INPUT_REQUIRED', 'A2A_AUTH_REQUIRED', 'A2A_INVALID_OUTPUT'];
  const a2aConfiguration = ['A2A_CONNECTION_NOT_FOUND', 'A2A_CONNECTION_DISABLED', 'A2A_CONNECTION_CHANGED', 'A2A_VERSION_UNSUPPORTED', 'A2A_ENDPOINT_RESTRICTED'];
  if (a2aUnknown.includes(message)) return { code: message, stage, recoveries: ['check_existing'] };
  if (a2aConfiguration.includes(message)) return { code: message, stage, recoveries: ['fix_configuration'] };
  if (message === 'A2A_PUBLICATION_BLOCKED') return { code: message, stage, recoveries: [] };
  if (['A2A_CANCELLED', 'A2A_TASK_FAILED', 'A2A_REJECTED'].includes(message)) return { code: message, stage, recoveries: ['retry_member'] };
  const transportUncertain=message==='LLM_REQUEST_TIMEOUT'||message==='LLM request failed. Check provider URL and server network.';
  const code = transportUncertain ? 'LOCAL_DISPATCH_UNCERTAIN' : /^LOCAL_[A-Z_]+$/u.test(message) ? message : stage === 'parse' ? 'LOCAL_INVALID_RESULT' : nativeFailureCode(error);
  const uncertain = ['LOCAL_DISPATCH_UNCERTAIN','LOCAL_PAUSED','LOCAL_INTERRUPTED'].includes(code);
  const config = ['LOCAL_INVALID_CONFIGURATION','LOCAL_CONFIGURATION_UNSUPPORTED','LOCAL_LOGIN_REQUIRED','LOCAL_VERSION_UNSUPPORTED'].includes(code);
  const result = row.result && typeof row.result === 'object' ? row.result as Record<string, unknown> : {};
  const field = (key: string, max: number) => typeof row[key] === 'string' && /^[A-Za-z0-9_. ()–-]+$/u.test(String(row[key])) ? String(row[key]).slice(0,max) : undefined;
  return { code, stage, recoveries: stage === 'parse' ? ['reparse_existing'] : uncertain ? ['check_existing'] : config ? ['fix_configuration','retry_member'] : ['retry_member'],
    ...(field('fieldPath',160) ? { fieldPath: field('fieldPath',160), expectedType: field('expectedType',120), actualType: field('actualType',80) } : {}),
    ...(Number.isInteger(result.code) ? { exitCode: Number(result.code) } : {}),
    ...(typeof result.outputBytes === 'number' ? { outputBytes: result.outputBytes }
      : typeof result.stdout === 'string' ? { outputBytes: Buffer.byteLength(result.stdout) } : {}),
    ...(typeof result.stderrBytes === 'number' ? { stderrBytes: result.stderrBytes }
      : typeof result.stderr === 'string' ? { stderrBytes: Buffer.byteLength(result.stderr) } : {}) };
}

type ProviderFailureCode = 'NATIVE_AGENT_USAGE_LIMIT' | 'NATIVE_AGENT_RATE_LIMIT' | 'NATIVE_AGENT_NETWORK_FAILED';

/** Only this typed, allowlisted failure may cross a process callback boundary. */
export class NativeProviderFailure extends Error {
  constructor(code: ProviderFailureCode) { super(code); }
}

// Read only diagnostic fields after the caller has identified an error event.
// Never classify normal assistant text, tool results, or whole provider responses.
function diagnosticText(value: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (typeof value === 'string') return value.slice(0, 8192);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.slice(0, 8).map(item => diagnosticText(item, depth + 1)).join(' ').slice(0, 8192);
  if (!value || typeof value !== 'object') return '';
  const data = value as Record<string, unknown>;
  return ['error', 'errors', 'message', 'code', 'type', 'name', 'status', 'statusCode', 'data', 'cause']
    .map(key => diagnosticText(data[key], depth + 1)).join(' ').slice(0, 8192);
}

export function providerLimitFailure(diagnostic: unknown): NativeProviderFailure | undefined {
  const text = diagnosticText(diagnostic).replace(/[_-]/gu, ' ');
  // A provider can return HTTP 429 for exhausted credits as well as transient throttling.
  if (/insufficient quota|(?:free )?usage limit(?: reached| exceeded)?|hit your (?:(?:daily|weekly|monthly) )?limit|billing hard limit|(?:insufficient|exhausted) (?:credit|balance)|credit balance (?:is )?too low|(?:credit|balance|monthly|daily) (?:limit |quota )?(?:exceeded|exhausted)|余额不足|额度(?:不足|用尽|已耗尽)|用量(?:受限|已达上限)/iu.test(text)) {
    return new NativeProviderFailure('NATIVE_AGENT_USAGE_LIMIT');
  }
  if (/rate limit|too many requests|\b429\b|resource exhausted|requests? per minute|tokens? per minute|请求(?:过于)?频繁|限流/iu.test(text)) {
    return new NativeProviderFailure('NATIVE_AGENT_RATE_LIMIT');
  }
  if (/quota (?:exceeded|exhausted|limit)|exceeded (?:your (?:current )?)?quota|配额(?:不足|耗尽|超限)/iu.test(text)) {
    return new NativeProviderFailure('NATIVE_AGENT_USAGE_LIMIT');
  }
  return undefined;
}

export function providerFailure(diagnostic: unknown, fallback = 'NATIVE_AGENT_FAILED'): Error {
  return providerLimitFailure(diagnostic) ?? (NETWORK_FAILURE_PATTERN.test(diagnosticText(diagnostic))
    ? new NativeProviderFailure('NATIVE_AGENT_NETWORK_FAILED') : new Error(fallback));
}

/** Strong network/transport signals emitted by a CLI when its model endpoint is unreachable. */
const NETWORK_FAILURE_PATTERN = /(?:workspace routing discovery failed|transport channel closed|\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN|EPIPE)\b|could not resolve (?:host|hostname)|\bgetaddrinfo\b|fetch failed|network request failed|network error|failed to connect|connection (?:refused|reset|timed out|closed)|(?:request|connect|socket|network|upstream|endpoint|transport) (?:timed out|timeout)|(?:proxy|tunnel) connection (?:failed|refused|closed|timed out)|\bproxyconnect tcp\b)/iu;

/** Recognize public error envelopes; ordinary assistant and tool payloads are never diagnostics. */
function processErrorDiagnostic(value: unknown, stderr: boolean): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const event = value as Record<string, unknown>;
  if (event.type === 'error' || event.type === 'turn.failed') return diagnosticText(event);
  if (event.role === 'error') return diagnosticText([event, event.content]);
  if (event.type === 'result' && (event.is_error === true
    || typeof event.subtype === 'string' && event.subtype !== 'success'
    || ['error', 'failed', 'cancelled'].includes(String(event.status)))) return diagnosticText([event, event.result]);
  if (event.event === 'result' && event.result && typeof event.result === 'object') {
    const result = event.result as Record<string, unknown>;
    return result.status !== 'SUCCESS' ? diagnosticText(result) : '';
  }
  if (event.type === undefined && event.event === undefined && event.role === undefined
    && ['failed', 'cancelled'].includes(String(event.status))) return diagnosticText(event);
  if (stderr && (event.error !== undefined || event.errors !== undefined
    || /^E[A-Z_]+$/u.test(String(event.code))
    || ['ERROR', 'error'].includes(String(event.level ?? event.severity)))) return diagnosticText(event);
  return '';
}

function streamHasNetworkFailure(text: string, stderr: boolean): boolean {
  if (!text.trim()) return false;
  // Whole-value parsing also handles pretty-printed errors without treating their
  // individual content fields as unstructured log lines.
  try { return NETWORK_FAILURE_PATTERN.test(processErrorDiagnostic(JSON.parse(text), stderr)); }
  catch { /* JSONL and plain CLI startup diagnostics are inspected line by line. */ }
  return text.split(/\r?\n/u).some(line => {
    try { return NETWORK_FAILURE_PATTERN.test(processErrorDiagnostic(JSON.parse(line), stderr)); }
    catch {
      // A malformed or truncated JSON content field is not verified failure evidence.
      if (/^\s*["{}\[\]]/u.test(line)) return false;
      return NETWORK_FAILURE_PATTERN.test(line);
    }
  });
}

/** Inspect a failed CLI process and classify connectivity failures distinctly from generic task errors. */
export function detectNetworkFailure(result: { stdout?: string; stderr?: string }): string | null {
  return streamHasNetworkFailure(result.stderr ?? '', true) || streamHasNetworkFailure(result.stdout ?? '', false)
    ? 'NATIVE_AGENT_NETWORK_FAILED' : null;
}

/** OpenCode can log a primary stream failure without emitting a terminal JSON event. */
export function readOpenCodeDiagnostic(line: string): void {
  if (!/(?:^ERROR\b|\blevel=ERROR\b)/u.test(line)
    || !/\bservice="?llm"?(?:\s|$)|\bmessage="stream error"/u.test(line)
    || /\bsmall=true\b|\bagent=(?:"?title"?)(?:\s|$)/u.test(line)) return;
  const error = /\berror(?:\.error)?=(.*)$/u.exec(line)?.[1];
  if (!error) return;
  const failure = providerLimitFailure(error) ?? (NETWORK_FAILURE_PATTERN.test(error)
    ? new NativeProviderFailure('NATIVE_AGENT_NETWORK_FAILED') : undefined);
  if (failure) throw failure;
}
