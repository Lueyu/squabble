export type ModelConnectionTestState = 'pending' | 'failed' | 'passed';

/** 用户自有的 OpenAI 兼容连接。API 响应只公开密钥掩码和状态。 */
export interface ModelConnection {
  id: string;
  name: string;
  baseUrl: string;
  fastModel: string;
  slowModel: string;
  /** 仅当服务端能解密已存密钥时为 true。 */
  hasApiKey: boolean;
  /** 使用与 hasApiKey 相同的判定。测试状态由 testState 单独返回。 */
  available: boolean;
  testState?: ModelConnectionTestState;
  /** 上次成功测试的 ISO 时间戳。 */
  testedAt?: string;
  /** 仅保留密钥末四位。 */
  maskedApiKey?: string;
  /** 已存密钥无法解密时为 true。 */
  needsReentry?: boolean;
}

export interface SaveModelConnection {
  name: string;
  baseUrl: string;
  fastModel: string;
  slowModel: string;
  /** 明文密钥。更新时省略或留空会沿用仍可解密的密钥，端点变更时必须提供。 */
  apiKey?: string;
}
