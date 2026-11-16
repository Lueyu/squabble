/**
 * model-connections.interface.ts — 用户自有 OpenAI 兼容模型连接的契约。
 *
 * 职责边界：
 *  - 只定义两种数据形状：读取形态 ModelConnection（API 响应）与保存形态
 *    SaveModelConnection（创建/更新请求体），不含任何运行时逻辑。
 *  - 凭据边界：响应形态永远不携带 apiKey，只暴露掩码与状态位；明文密钥仅在
 *    保存请求中出现，由服务端加密落库后不再回传。
 * 上下游：
 *  - 上游：server/modules/settings/*（连接管理服务）与 client/src 连接设置界面，
 *    共 4 个文件 import 本契约（server 2、client 2）。
 *  - 下游：无——本文件不引用任何其他 shared 契约。
 * 关键约定：
 *  - fastModel / slowModel：快/慢两条模型通道各自使用的模型名。
 *  - maskedApiKey：形如 "••••1234" 的掩码（仅保留末 4 位）。
 *  - needsReentry：true 表示已存密钥不可读（如主机加密密钥变更），需重新录入。
 */

/** 读取形态：连接的对外展示数据（响应体）。凭据永不回传，只给掩码与状态位。 */
export interface ModelConnection {
  /** 连接 id。 */
  id: string;
  /** 用户命名的连接名称。 */
  name: string;
  /** OpenAI 兼容 API 的 base URL。 */
  baseUrl: string;
  /** 快通道模型名。 */
  fastModel: string;
  /** 慢通道模型名。 */
  slowModel: string;
  /** 是否存有可读密钥（服务端按"密钥可解密"判定，不含密钥本身）。 */
  hasApiKey: boolean;
  /** 连接当前是否可用（与 hasApiKey 同源判定）。 */
  available: boolean;
  /** 掩码密钥（仅末 4 位可见）；未存密钥时省略。 */
  maskedApiKey?: string;
  /** true 表示存量密钥不可读，需要用户重新录入。 */
  needsReentry?: boolean;
}

/** 保存形态：创建/更新连接的请求体。 */
export interface SaveModelConnection {
  /** 用户命名的连接名称。 */
  name: string;
  /** OpenAI 兼容 API 的 base URL。 */
  baseUrl: string;
  /** 快通道模型名。 */
  fastModel: string;
  /** 慢通道模型名。 */
  slowModel: string;
  /** 明文 API key：省略或传空字符串表示保留已存密钥。 */
  apiKey?: string;
}
