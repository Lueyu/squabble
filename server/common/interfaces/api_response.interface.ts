/**
 * 统一错误响应信封（envelope）。
 *
 * 职责边界：只声明失败响应的数据形状，不含运行时逻辑。
 *
 * 上下游：由 `GlobalExceptionFilter`（server/common/filters/exception.filter.ts）
 * 把所有失败响应序列化成这个形状，因此前端永远拿到
 * `{ error: { code, message, ... } }`，与底层异常类型无关。
 */
export interface ApiErrorResponse {
  /** 包裹（wrap）起来的错误载荷。 */
  error: {
    /** 稳定的业务错误码（见 `ResponseCode`）。 */
    code: string;
    /** 人类可读的错误消息。 */
    message: string;
    /** 额外的结构化细节（常见为 JSON 字符串）。 */
    details?: string;
    /** 安全的预算元数据，不含 prompt 或 provider 凭据。 */
    reason?: string;
    taskId?: string;
    /** 按字段名索引的逐字段校验错误。 */
    fieldErrors?: Record<string, string[]>;
    /** 堆栈跟踪，仅未预期的服务端错误才携带。 */
    stack?: string;
    /** 底层错误的 cause。 */
    cause?: string;
    /** 错误发生时的 Unix 毫秒时间戳。 */
    timestamp?: number;
  };
}
