import type { CouncilResponse } from '../../../shared/council.interface';
import { readableResearch } from '../../../shared/research-reading';
export class CouncilOutputError extends Error {
  constructor(readonly fieldPath: string, readonly expectedType: string, readonly actualType: string) {
    super(`Invalid structured response at ${fieldPath}: expected ${expectedType}; received ${actualType}`);
  }
}
const actualType = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
function text(value: unknown, max: number, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new CouncilOutputError(path, `nonempty string (max ${max})`, actualType(value));
  const normalized=readableResearch(value);
  if(!normalized)throw new CouncilOutputError(path,'readable research text','unrecognized protocol');
  return normalized;
}
/** One known historical shape, one level only. Preserve every section and insertion order. */
export function normalizeResponseDetails(value: unknown): string {
  if (typeof value === 'string') return text(value, 30000, 'response.details');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new CouncilOutputError('response.details', 'string or bounded text record', actualType(value));
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 16 || entries.some(([key, segment]) => !key.trim() || key.length > 120 || typeof segment !== 'string' || !segment.trim()))
    throw new CouncilOutputError('response.details', '1–16 text sections', 'object');
  return text(entries.map(([key, segment]) => `### ${key}\n${segment}`).join('\n\n'), 30000, 'response.details');
}
export function parseResponse(value: unknown): CouncilResponse | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CouncilOutputError('response', 'object', actualType(value));
  const data = value as Record<string, unknown>;
  const points = (raw: unknown, path: string): string[] => {
    if (!Array.isArray(raw) || raw.length > 12) throw new CouncilOutputError(path, 'array (max 12)', actualType(raw));
    return raw.map((item, index) => text(item, 4000, `${path}.${index}`));
  };
  const response: CouncilResponse = { thesis: text(data.thesis, 6000, 'response.thesis'), evidencePoints: points(data.evidencePoints, 'response.evidencePoints'),
    risks: points(data.risks, 'response.risks'), nextChecks: points(data.nextChecks, 'response.nextChecks'),
    ...(data.details === undefined ? {} : { details: normalizeResponseDetails(data.details) }) };
  if (JSON.stringify(response).length > 50000) throw new CouncilOutputError('response', 'object (max 50000)', 'oversized object');
  return response;
}
