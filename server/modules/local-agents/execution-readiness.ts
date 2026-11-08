import type { LocalAgentConnection, NativeAgentConfiguration } from '../../../shared/local-agents.interface';
import type { ResearchExecutionReadiness } from '../../../shared/research-execution.interface';
import { validateNativeAgentConfiguration } from './local-agents.requests';

/** No probes or paid requests: project local metadata and app overrides. */
export function executionReadiness(item: LocalAgentConnection, settings?: NativeAgentConfiguration): ResearchExecutionReadiness {
  const requestedModel = settings?.model ?? item.defaultModel;
  let model = requestedModel;
  // Tolerate a bare OpenCode default by resolving it against the advertised
  // provider/model ids when the match is unambiguous, so a default config works
  // without forcing users to learn the provider/model naming.
  if (item.provider === 'opencode' && model && !/^[^/\s]+\/[^\s]+$/u.test(model)) {
    const matches = (item.models ?? []).map(entry => entry.id).filter(id => id === model || id.endsWith(`/${model}`));
    if (new Set(matches).size === 1) model = matches[0];
  }
  const effectiveModel: ResearchExecutionReadiness['effectiveModel'] = { ...(model ? { id: model } : {}),
    source: settings?.model ? 'override' : model ? 'default' : 'unknown', verified: Boolean(model),
    ...(item.provider === 'opencode' && model?.includes('/') ? { provider: model.split('/')[0] } : {}) };
  const base = { connectionId: item.id, provider: item.provider, name: item.name, connected: item.connected, busy: item.busy, effectiveModel,
    ...(settings?{configuration:settings}:{}),...(item.models?{models:item.models}:{}),...(item.reasoningEfforts?{reasoningEfforts:item.reasoningEfforts}:{}) };
  if (!item.connected) return { ...base, state: 'not_connected', executable: false };
  if (item.state === 'login_required') return { ...base, state: 'login_required', executable: false,
    failure: { code: 'LOCAL_LOGIN_REQUIRED', stage: 'preflight', recoveries: ['fix_configuration'] } };
  const effectiveSettings = item.provider === 'opencode' && model ? { ...settings, model } : settings;
  try {
    validateNativeAgentConfiguration(effectiveSettings, item);
    // OpenCode splits provider/model. A bare default becomes provider + empty model.
    if (item.provider === 'opencode' && model && !/^[^/\s]+\/[^\s]+$/u.test(model)) throw new Error('LOCAL_INVALID_CONFIGURATION');
  } catch (error) {
    return { ...base, state: 'configuration_required', executable: false, failure: {
      code: error instanceof Error && error.message === 'LOCAL_CONFIGURATION_UNSUPPORTED' ? error.message : 'LOCAL_INVALID_CONFIGURATION',
      stage: 'preflight', recoveries: ['fix_configuration'] } };
  }
  if (!item.available) return { ...base, state: 'unknown', executable: false, failure: { code: 'LOCAL_UNAVAILABLE', stage: 'preflight', recoveries: ['check_existing'] } };
  const route = { mode: 'local' as const, agentId: item.id, ...(effectiveSettings ? { agentSettings: effectiveSettings } : {}) };
  if (item.busy) return { ...base, route, state: 'busy', executable: false };
  return { ...base, state: 'ready', executable: true, route };
}
