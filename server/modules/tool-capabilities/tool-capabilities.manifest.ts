import type { AgentDataClass } from '../../../shared/agent-tooling.interface';
import { TOOL_CAPABILITY_PACK_IDS, type ToolCapabilityPackId } from '../../../shared/tool-capabilities.interface';
import { canonicalHash } from '../../common/agent-contract';

/** The bundled gateway owns this fixed contract; discovery cannot enlarge its operation allowlist. */
export const AKTOOLS_GET_DATA_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { name: { type: 'string' }, params: { type: 'object', additionalProperties: { type: 'string' } },
    max_rows: { type: 'integer', minimum: 1, maximum: 1000 }, offset: { type: 'integer', minimum: 0 } },
  required: ['name', 'params', 'max_rows', 'offset'],
};
export const CAPABILITY_MANIFEST_VERSION = 'bundled-tools-v1';
export const MAX_READINESS_AGE_MS = 5 * 60_000;
export function capabilityManifest(packId: ToolCapabilityPackId) {
  const localClasses: AgentDataClass[] = ['public', 'private_material', 'portfolio', 'application'];
  const definitions = {
    documents: { service: 'docling', version: '1.38.2', endpoint: process.env.DOCUMENT_DOCLING_URL ?? '',
      health: process.env.TOOL_CAPABILITIES_DOCLING_HEALTH_URL ?? '', operations: ['document.extract', 'library.search'],
      dataClasses: localClasses, publicNetwork: false },
    market_data: { service: 'aktools', version: '0.1.5', endpoint: process.env.FINANCIAL_AKTOOLS_MCP_URL ?? '',
      operations: ['stock_zh_a_hist', 'stock_financial_hk_report_em'], inputSchema: AKTOOLS_GET_DATA_SCHEMA,
      dataClasses: ['public'] as AgentDataClass[], publicNetwork: true },
    browser: { service: 'chromium', version: 'playwright-1.65.0', operations: ['navigate', 'read', 'next', 'expand', 'screenshot', 'close'],
      dataClasses: ['public'] as AgentDataClass[], publicNetwork: true },
    compute: { service: 'local-container', version: 'protocol-1', endpoint: process.env.SANDBOX_BROKER_URL ?? '',
      operations: ['statistics', 'backtest', 'exploratory'], dataClasses: localClasses, publicNetwork: false },
  };
  const definition = definitions[packId];
  return { packId, version: CAPABILITY_MANIFEST_VERSION, ...definition,
    configurationHash: canonicalHash({ packId, version: CAPABILITY_MANIFEST_VERSION, ...definition }) };
}
export function capabilityPackId(input: string): input is ToolCapabilityPackId {
  return TOOL_CAPABILITY_PACK_IDS.includes(input as ToolCapabilityPackId);
}
