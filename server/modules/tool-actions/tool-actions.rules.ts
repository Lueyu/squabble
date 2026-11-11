import { z } from 'zod';
import { toolHash } from '../tool-connections/tool-catalog.service';
import type { AgentToolDescriptor, AgentToolScope } from '../../../shared/agent-tooling.interface';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

export interface ToolActionPreviewInput {
  runId: string; stepId: string; toolCallId: string; descriptor: AgentToolDescriptor; connectionRevision: number;
  args: Record<string, unknown>; scope: AgentToolScope; accountId: string; target: string;
  attachments: Array<{ artifactId: string; sha256: string }>;
  costLimit: { maxCalls: number; maxAmount: string | null; currency: string | null };
  resourceVersion: string | null;
}
export interface ToolActionPreview extends ToolActionPreviewInput {
  id: string; revision: number; payloadHash: string; state: string; expiresAt: string;
  receipt: { state: 'completed' | 'failed' | 'unknown'; code?: string; remoteId?: string } | null;
}

export function validatePreview(input: ToolActionPreviewInput): void {
  if (!z.string().uuid().safeParse(input.runId).success || !z.string().uuid().safeParse(input.stepId).success
    || !input.toolCallId || input.toolCallId.length > 250 || input.descriptor.effect !== 'external_write'
    || !input.descriptor.connectionId || !Number.isSafeInteger(input.connectionRevision) || input.connectionRevision < 1
    || input.scope.runId !== input.runId || typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 250
    || typeof input.target !== 'string' || !input.target || input.target.length > 4000
    || !input.args || typeof input.args !== 'object' || Array.isArray(input.args) || Buffer.byteLength(JSON.stringify(input)) > 200_000
    || !Number.isInteger(input.costLimit.maxCalls) || input.costLimit.maxCalls !== 1 || input.attachments.length > 20
    || input.attachments.some(attachment => !z.string().uuid().safeParse(attachment.artifactId).success || !/^[a-f0-9]{64}$/u.test(attachment.sha256))) {
    throw new Error('INVALID_TOOL_ACTION_PREVIEW');
  }
  if ((input.costLimit.maxAmount !== null && !/^\d+(\.\d{1,8})?$/u.test(input.costLimit.maxAmount))
    || (input.costLimit.currency !== null && !/^[A-Z]{3}$/u.test(input.costLimit.currency))) throw new Error('INVALID_TOOL_ACTION_PREVIEW');
  if (!new AjvJsonSchemaValidator().getValidator(input.descriptor.inputSchema)(input.args).valid) throw new Error('INVALID_TOOL_ACTION_PREVIEW');
}
export function previewHash(input: ToolActionPreviewInput): string {
  // Mutable worker lease tokens are not authorization; all business scope and permission revisions are.
  return toolHash({ ...input, scope: { ...input.scope, leaseToken: '' } });
}
