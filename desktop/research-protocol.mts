// Electron builds with an independent rootDir. These narrow wire types mirror
// shared/research-{tools,events}.interface.ts; HTTP integration tests check both sides.
export interface ResearchSource { title: string; url?: string; fetchedAt: string }
export interface ResearchToolDescriptor {
  name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>;
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: boolean };
}
export interface ResearchToolRequest { callId: string; name: string; arguments: Record<string, unknown> }
export interface ResearchToolResult {
  status: 'succeeded' | 'partial' | 'unavailable' | 'failed' | 'cancelled';
  data: unknown; sources: ResearchSource[]; asOf: string; truncated: boolean; errorCode?: string;
}
export interface ResearchToolBundle { descriptors: ResearchToolDescriptor[]; snapshot: string }
export interface ResearchToolCapability {
  mode: 'mcp' | 'snapshot'; reason: 'supported' | 'version_unsupported' | 'runtime_unsupported';
}
export interface ResearchActivity {
  id: string; kind: 'task' | 'tool' | 'summary' | 'capability';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable';
  at: string; summary: string; toolName?: string; callId?: string; durationMs?: number; sources?: ResearchSource[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max; }
function date(value: unknown): value is string { return text(value, 40) && Number.isFinite(Date.parse(value)); }
function jsonSize(value: unknown, max: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= max; } catch { return false; }
}
function localSchema(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (Array.isArray(value)) return value.every(item => localSchema(item, depth + 1));
  if (!object(value)) return true;
  return Object.entries(value).every(([key, item]) =>
    (!['$ref', '$dynamicRef', '$recursiveRef'].includes(key) || typeof item === 'string' && item.startsWith('#'))
    && localSchema(item, depth + 1));
}
function schema(value: unknown): value is Record<string, unknown> {
  return object(value) && value.type === 'object' && jsonSize(value, 16_000) && localSchema(value);
}
function descriptor(value: unknown): value is ResearchToolDescriptor {
  return object(value) && onlyKeys(value, ['name', 'description', 'inputSchema', 'outputSchema', 'annotations'])
    && typeof value.name === 'string' && /^[a-z_]{1,80}$/u.test(value.name)
    && text(value.description, 2_000) && schema(value.inputSchema)
    && (value.outputSchema === undefined || schema(value.outputSchema))
    && object(value.annotations) && onlyKeys(value.annotations, ['readOnlyHint', 'destructiveHint', 'openWorldHint'])
    && value.annotations.readOnlyHint === true && value.annotations.destructiveHint === false
    && typeof value.annotations.openWorldHint === 'boolean';
}
export function validResearchBundle(value: unknown): value is ResearchToolBundle {
  return object(value) && onlyKeys(value, ['descriptors', 'snapshot']) && text(value.snapshot, 64_000)
    && Buffer.byteLength(value.snapshot, 'utf8') <= 64_000
    && Array.isArray(value.descriptors) && value.descriptors.length <= 16 && value.descriptors.every(descriptor)
    && new Set(value.descriptors.map(item => item.name)).size === value.descriptors.length && jsonSize(value, 256_000);
}
export function validResearchRequest(value: unknown, bundle: ResearchToolBundle): value is ResearchToolRequest {
  return object(value) && onlyKeys(value, ['callId', 'name', 'arguments'])
    && typeof value.callId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value.callId)
    && typeof value.name === 'string' && bundle.descriptors.some(tool => tool.name === value.name)
    && object(value.arguments) && jsonSize(value.arguments, 4_096);
}
function source(value: unknown): value is ResearchSource {
  if (!object(value) || !onlyKeys(value, ['title', 'url', 'fetchedAt'])
    || !text(value.title, 160) || !date(value.fetchedAt)) return false;
  if (value.url === undefined) return true;
  if (!text(value.url, 2_048)) return false;
  try {
    const url = new URL(value.url);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
export function validResearchResult(value: unknown): value is ResearchToolResult {
  return object(value) && onlyKeys(value, ['status', 'data', 'sources', 'asOf', 'truncated', 'errorCode'])
    && typeof value.status === 'string' && ['succeeded', 'partial', 'unavailable', 'failed', 'cancelled'].includes(value.status)
    && Object.hasOwn(value, 'data') && Array.isArray(value.sources) && value.sources.length <= 12 && value.sources.every(source)
    && date(value.asOf) && typeof value.truncated === 'boolean'
    && (value.errorCode === undefined || typeof value.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value.errorCode));
}
export function validResearchActivity(value: unknown): value is ResearchActivity {
  return object(value) && onlyKeys(value, ['id', 'kind', 'status', 'at', 'summary', 'toolName', 'callId', 'durationMs', 'sources'])
    && typeof value.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value.id)
    && typeof value.kind === 'string' && ['task', 'tool', 'summary', 'capability'].includes(value.kind)
    && typeof value.status === 'string' && ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unavailable'].includes(value.status)
    && date(value.at) && text(value.summary, 2_000)
    && (value.toolName === undefined || text(value.toolName, 101)) && (value.callId === undefined || text(value.callId, 128))
    && (value.durationMs === undefined || typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
      && value.durationMs >= 0 && value.durationMs <= 600_000)
    && (value.sources === undefined || Array.isArray(value.sources) && value.sources.length <= 8 && value.sources.every(source));
}
export function researchFailure(status: 'unavailable' | 'failed' | 'cancelled', errorCode: string, started = false): ResearchToolResult {
  return { status, data: { message: errorCode,
    ...(started ? { completion: 'The upstream request may still continue; its completion and any provider charge are unknown.' } : {}) },
  sources: [], asOf: new Date().toISOString(), truncated: false, errorCode };
}
