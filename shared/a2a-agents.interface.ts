/** Supported profile: A2A v1.0 JSON-RPC, nonstreaming text/JSON output only. */
export interface A2aConnectionFingerprint {
  connectionId: string; connectionRevision: number; cardHash: string;
  protocolVersion: '1.0'; interfaceUrl: string; tenant?: string;
}
export interface A2aSkill { id: string; name: string; description: string }
export interface A2aCapabilities {
  structuredOutput: boolean; structuredOutputVerified: boolean; toolsKnown: false; feesKnown: false;
}
export interface A2aConnection {
  id: string; name: string; cardUrl: string; revision: number; status: 'enabled' | 'disabled';
  cardHash: string; protocolVersion: '1.0'; interfaceUrl: string; tenant?: string;
  cardName: string; cardVersion: string; skills: A2aSkill[]; capabilities: A2aCapabilities;
  credentialConfigured: boolean; localEndpoint: boolean; updatedAt: string;
}
export interface A2aCreateConnection {
  requestKey: string; name: string; cardUrl: string; credential?: string; trustLocalEndpoint?: boolean;
}
export type A2aTaskState = 'dispatch_intent' | 'dispatch_unknown' | 'submitted' | 'working' | 'completed'
  | 'failed' | 'cancelled' | 'rejected' | 'input_required' | 'auth_required';
export interface A2aTaskReceipt {
  id: string; connectionId: string; messageId: string; remoteTaskId: string | null; contextId: string | null;
  state: A2aTaskState; acceptance: 'pending' | 'accepted' | 'invalid' | 'blocked';
  cancellation: 'none' | 'requested' | 'confirmed' | 'refused' | 'unknown';
  externalUsageUnknown: true; externalCostUnknown: true; modelKnown: false; toolsKnown: false;
  outputBytes: number; failureCode: string | null; createdAt: string; updatedAt: string;
}
