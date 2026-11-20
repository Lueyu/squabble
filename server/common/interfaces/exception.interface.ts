/**
 * 领域（业务）异常。
 *
 * 职责边界：当请求违反业务规则时由 service 抛出（例如持仓不足以卖出、
 * watchlist 重复添加、非法状态流转）；自带明确的业务 `ResponseCode` 与可选
 * HTTP 状态码，最终由 `GlobalExceptionFilter` 翻译成统一错误信封。
 *
 * 上下游：import ResponseCode 与码表（../constants/api_response_code）；
 * 被各业务 service 抛出，被全局异常过滤器捕获。
 */
import { HttpStatus } from '@nestjs/common';
import { RESPONSE_CODE_TO_HTTP_STATUS_MAP, ResponseCode } from '../constants/api_response_code';

/**
 * 预期内的领域级失败的错误类型。继承 `Error`，因此可以正常配合
 * `instanceof` 判断和 stack trace。
 */
export class BusinessException extends Error {
  /**
   * @param code        对失败分类的业务结果码。
   * @param message     人类可读的失败描述。
   * @param httpStatus  返回的 HTTP 状态码；默认 400 Bad Request。
   * @param details     可选的结构化细节字符串。
   * @param fieldErrors 可选的逐字段校验错误。
   */
  constructor(
    public readonly code: ResponseCode,
    public readonly message: string,
    public readonly httpStatus: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    // 固定异常名，便于过滤器与日志识别（不跟随子类名变化）。
    this.name = 'BusinessException';
  }

  /**
   * 通过正向映射表，把本异常携带的业务码解析为对应的 HTTP 状态码。
   * 注意：过滤器优先使用构造时显式传入的 `httpStatus` 字段；本方法是
   * 一个便利性的备用解析器。
   *
   * @returns 映射得到的 HTTP 状态码。
   */
  getHttpStatus(): HttpStatus {
    return RESPONSE_CODE_TO_HTTP_STATUS_MAP[this.code];
  }
}
