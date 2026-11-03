type ProviderFailureCode = 'NATIVE_AGENT_USAGE_LIMIT' | 'NATIVE_AGENT_RATE_LIMIT';

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
  return providerLimitFailure(diagnostic) ?? new Error(fallback);
}

/** OpenCode can log a primary stream failure without emitting a terminal JSON event. */
export function readOpenCodeDiagnostic(line: string): void {
  if (!/(?:^ERROR\b|\blevel=ERROR\b)/u.test(line)
    || !/\bservice="?llm"?(?:\s|$)|\bmessage="stream error"/u.test(line)
    || /\bsmall=true\b|\bagent=(?:"?title"?)(?:\s|$)/u.test(line)) return;
  const error = /\berror(?:\.error)?=(.*)$/u.exec(line)?.[1];
  if (!error) return;
  const failure = providerLimitFailure(error);
  if (failure) throw failure;
}
