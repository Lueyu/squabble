import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { canonicalHash } from '../../common/agent-contract';
import type { AgentToolDescriptor, AgentToolScope } from '../../../shared/agent-tooling.interface';
import { ModelStepService } from '../research-core/model-step.service';
import { ResearchRuntimeService } from './research-runtime.service';
import { RuntimeDispatchService } from './runtime-dispatch.service';
import { RuntimeJournalService } from './runtime-journal.service';
import { RuntimeInvocationsService } from './runtime-invocations.service';

const probeInput = z.strictObject({ requestKey: z.uuid(), connectionId: z.uuid().optional(), tier: z.enum(['fast', 'slow']), enable: z.boolean() });

/** GET is cached metadata; only an explicit POST may spend two bounded model requests. */
@Injectable()
export class ModelCapabilityService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly model: ModelStepService,
    private readonly journal: RuntimeJournalService, private readonly dispatch: RuntimeDispatchService,
    private readonly invocations: RuntimeInvocationsService) {}

  async enabled(owner: string, connectionId: string | undefined, tier: 'fast' | 'slow'): Promise<boolean> {
    const config = await this.model.resolve(owner, connectionId, tier);
    const rows = await this.db.execute(sql`select enabled from agent_model_capabilities where owner=${owner}
      and connection_id=${config.connectionId} and model=${config.model} and config_hash=${config.connectionConfigHash} and supported=true`);
    return rows[0]?.enabled === true;
  }
  async list(owner: string) {
    return this.db.execute(sql`select connection_id,model,supported,enabled,run_id,verified_at from agent_model_capabilities where owner=${owner} order by verified_at desc`);
  }
  async driver(owner: string, connectionId = ''): Promise<'controlled' | 'deep_agents'> {
    const rows = await this.db.execute(sql`select driver from agent_runtime_driver_preferences where owner=${owner} and connection_id=${connectionId}`);
    return rows[0]?.driver === 'deep_agents' ? 'deep_agents' : 'controlled';
  }
  async drivers(owner: string) {
    return this.db.execute(sql`select connection_id,driver from agent_runtime_driver_preferences where owner=${owner}`);
  }
  async setDriver(owner: string, raw: unknown): Promise<void> {
    const parsed = z.strictObject({ connectionId: z.union([z.uuid(), z.literal('')]), driver: z.enum(['controlled','deep_agents']) }).safeParse(raw);
    if (!parsed.success) throw new BadRequestException('RUNTIME_DRIVER_INVALID');
    await this.model.resolve(owner, parsed.data.connectionId || undefined, 'fast');
    await this.db.execute(sql`insert into agent_runtime_driver_preferences(owner,connection_id,driver)
      values(${owner},${parsed.data.connectionId},${parsed.data.driver}) on conflict(owner,connection_id)
      do update set driver=excluded.driver,updated_at=now()`);
  }
  async probe(owner: string, input: unknown) {
    const validation = probeInput.safeParse(input);
    if (!validation.success) throw new BadRequestException('MODEL_CAPABILITY_PROBE_INVALID');
    const parsed = validation.data, config = await this.model.resolve(owner, parsed.connectionId, parsed.tier);
    // The request identity fixes the nonce and synthetic session across a lost HTTP response.
    const nonce = canonicalHash({ owner, requestKey: parsed.requestKey }).slice(0, 24);
    const descriptor: AgentToolDescriptor = { id: 'capability_echo', name: 'capability_echo', connectionId: null,
      catalogVersionId: 'capability-echo-v1', schemaHash: canonicalHash({ version: 1 }),
      description: 'Return the supplied probe nonce unchanged. This tool has no external effects.',
      inputSchema: { type: 'object', properties: { nonce: { type: 'string', enum: [nonce] } }, required: ['nonce'], additionalProperties: false },
      effect: 'read', dataClasses: ['public'], timeoutMs: 1000, maxOutputBytes: 2000,
      supportsCancellation: true, supportsStatusLookup: false, remoteIdempotency: 'supported' };
    const payload = { holdings: [], cash: [], sourcePayloads: [], context: { nonce } };
    const run = await this.journal.create({ identity: { owner, sessionId: parsed.requestKey, cycleId: parsed.requestKey,
      memberId: 'capability-probe', revision: 1, turn: 0, executionAttempt: 1 }, driver: 'controlled',
      frozenInput: { version: 1, datasetVersionIds: [], datasets: [], payload, payloadHash: canonicalHash(payload) },
      policy: { purpose: 'capability_probe', maxSteps: 2, maxTools: 1, loopOwner: 'runtime', maxModelRequestsPerStep: 1,
        sdkRetries: 0, sdkToolExecution: false, sdkToolApproval: false, providerExecutedWrites: false, fallback: null,
        model: config.model, configHash: config.connectionConfigHash } });
    const scope: AgentToolScope = { owner, runId: run.id, sessionId: parsed.requestKey, revision: 1, leaseToken: '',
      allowedInstrumentIds: [], allowedAccountIds: [], allowedDataClasses: ['public'], sourceVersions: [], permissionRevision: 1 };
    const runtime = new ResearchRuntimeService(this.journal, this.model, this.invocations, {
      dispatch: this.dispatch, shouldContinue: async () => !(await this.journal.read(owner, run.id)).cancelRequested,
      assertScope: async () => { await this.model.resolve(owner, parsed.connectionId, parsed.tier); },
      tools: { invoke: async (_descriptor, args) => ({ nonce: args.nonce }) },
      approvals: { park: async () => { throw new Error('MODEL_PROBE_WRITE_FORBIDDEN'); } },
    });
    const outcome = await runtime.execute({ owner, runId: run.id, scope,
      modelRequest: { ...config, owner, connectionRevision: 1, maxOutputTokens: 200, timeoutMs: 30_000,
        catalog: { catalogVersionId: 'capability-echo-v1', descriptors: [descriptor], schemaHash: canonicalHash(descriptor),
          connectionRevisions: {}, aliases: { capability_echo: descriptor.id } },
        messages: [{ role: 'user', content: `Call capability_echo exactly once with nonce ${nonce}. After the tool result, reply with only its nonce.` }] },
      validateFinal: async text => {
        if (await this.invocations.count(owner, run.id) !== 1 || text.trim() !== nonce) throw new Error('MODEL_TOOL_ROUNDTRIP_NOT_VERIFIED');
      } });
    const supported = outcome.status === 'accepted';
    if (supported) await this.db.execute(sql`insert into agent_model_capabilities(owner,connection_id,model,config_hash,run_id,supported,enabled)
      values(${owner},${config.connectionId},${config.model},${config.connectionConfigHash},${run.id},true,${parsed.enable})
      on conflict(owner,connection_id,model,config_hash) do update set run_id=excluded.run_id,supported=true,enabled=excluded.enabled,verified_at=now()`);
    return { runId: run.id, status: outcome.status, supported, enabled: supported && parsed.enable };
  }
  async disable(owner: string, connectionId: string): Promise<void> {
    await this.db.execute(sql`update agent_model_capabilities set enabled=false where owner=${owner} and connection_id=${connectionId}`);
  }
}
