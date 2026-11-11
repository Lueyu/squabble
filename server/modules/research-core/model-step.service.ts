import { Inject, Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import type { ResolvedLlmConfig } from '../settings/settings.service';
import { canonicalHash } from '../../common/agent-contract';
import { AiSdkModelAdapter } from './ai-sdk-model.adapter';
import type { ModelStepPort, ModelStepRequest, ModelStepResult } from './model-step.interface';

/** Credentials are resolved server-side immediately before the one authorized send. */
@Injectable()
export class ModelStepService implements ModelStepPort {
  constructor(@Inject(SettingsService) private readonly settings: Pick<SettingsService, 'getLlmConfig'>,
    private readonly adapter: AiSdkModelAdapter) {}

  private fingerprint(connection: ResolvedLlmConfig): string {
    return canonicalHash({ baseUrl: connection.baseUrl, fastModel: connection.fastModel,
      slowModel: connection.slowModel, source: connection.source, credentialFingerprint: canonicalHash(connection.apiKey) });
  }

  async resolve(owner: string, connectionId: string | undefined, tier: 'fast' | 'slow'): Promise<{
    model: string; connectionId: string; connectionConfigHash: string;
  }> {
    const connection = await this.settings.getLlmConfig(owner, connectionId || undefined);
    if (!connection) throw new Error('MODEL_CONNECTION_UNAVAILABLE');
    return { model: tier === 'fast' ? connection.fastModel : connection.slowModel,
      connectionId: connectionId ?? '', connectionConfigHash: this.fingerprint(connection) };
  }

  async generate(request: ModelStepRequest, signal?: AbortSignal): Promise<ModelStepResult> {
    if (!request.connectionConfigHash) throw new Error('MODEL_CONNECTION_SNAPSHOT_REQUIRED');
    const connection = await this.settings.getLlmConfig(request.owner, request.connectionId || undefined);
    if (!connection) throw new Error('MODEL_CONNECTION_UNAVAILABLE');
    if (this.fingerprint(connection) !== request.connectionConfigHash) throw new Error('MODEL_CONNECTION_CHANGED');
    return this.adapter.generate(request, connection, signal);
  }
}
