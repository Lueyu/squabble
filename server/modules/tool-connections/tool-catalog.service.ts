import { randomUUID } from 'node:crypto';
import type { AgentToolDescriptor, AgentToolCatalogSnapshot } from '../../../shared/agent-tooling.interface';
import { canonicalHash } from '../../common/agent-contract';

export const toolHash = canonicalHash;

/** Reject all refs rather than letting a validator fetch or recursively expand untrusted schemas. */
export function validateToolSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 65_536) {
    throw new Error('SCHEMA_RESTRICTED');
  }
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 2000 || depth > 16) throw new Error('SCHEMA_RESTRICTED');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      // Native adapters own their schemas. Untrusted remote regexes cannot execute in the server process.
      if (['$ref', '$dynamicRef', '$recursiveRef', 'pattern', 'patternProperties', '__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('SCHEMA_RESTRICTED');
      visit(child, depth + 1);
    }
  };
  visit(input, 0);
  if ((input as Record<string, unknown>).type !== 'object') throw new Error('SCHEMA_RESTRICTED');
  return structuredClone(input as Record<string, unknown>);
}

export function catalogSnapshot(descriptors: AgentToolDescriptor[], revisions: Record<string, number>): AgentToolCatalogSnapshot {
  const aliases: Record<string, string> = {};
  descriptors.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).forEach((tool, index) => {
    aliases[`external_${index + 1}_${tool.name.replace(/[^a-zA-Z0-9_]/gu, '_').slice(0, 35)}`] = tool.id;
  });
  return { catalogVersionId: randomUUID(), schemaHash: toolHash({ descriptors, revisions, aliases }),
    connectionRevisions: { ...revisions }, descriptors: structuredClone(descriptors), aliases };
}
