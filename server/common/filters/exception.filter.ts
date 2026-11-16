/**
 * 全局异常过滤器。
 *
 * 职责边界：捕获请求生命周期内任何位置抛出的未处理异常，统一规范化为标准
 * `ApiErrorResponse` JSON 信封；自身不抛异常，除非响应头已发出，否则总会写出
 * 一条响应。按异常类型选择 HTTP 状态码与业务 `ResponseCode`：
 *   1. `BusinessException`   -> 使用其自带的 code/message/httpStatus；
 *   2. Nest `HttpException`  -> 状态码反向映射回 `ResponseCode`；
 *   3. Postgres 错误 `22P02`（invalid text representation，例如畸形 UUID）
 *      -> 按 404 NOT_FOUND 处理，让坏 UUID 表现为"资源不存在"而不是 500；
 *   4. 其余任意异常          -> 500 INTERNAL_ERROR（附带 stack/cause）。
 *
 * 上下游：import BusinessException、BudgetExceededException、码表与错误信封
 * 接口；在 `AppModule` 中以 `APP_FILTER` 注册为全局过滤器。
 */
import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { BusinessException } from '../interfaces/exception.interface';
import { HTTP_STATUS_TO_RESPONSE_CODE_MAP, ResponseCode } from '../constants/api_response_code';
import { ApiErrorResponse } from '../interfaces/api_response.interface';
import { BudgetExceededException } from '../../modules/llm-budget/llm-budget.rules';

/**
 * 兜底异常过滤器：把异常统一转成错误 JSON 响应体。它自身绝不抛异常；
 * （除非 headers 已发出）总会写出响应。
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  /**
   * 处理当前 HTTP 请求抛出的单个异常。
   *
   * @param exception 抛出的任意类型的值。
   * @param host      Nest ArgumentsHost，用于取出 Express response。
   */
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // 响应已提交（headers 已发送）时无法再安全写响应，只能放弃。
    if (response.headersSent) {
      return;
    }

    // errorResponse 的形状即错误信封；Omit 为历史遗留（信封并无 httpStatus
    // 键），保留原写法不改动。
    let errorResponse: Omit<ApiErrorResponse, 'httpStatus'>;
    let httpStatus: HttpStatus;

    if (exception instanceof BusinessException) {
      // 分支 1：领域级业务异常 —— 直接信任其显式 code/message/status。
      httpStatus = exception.httpStatus;
      errorResponse = {
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          fieldErrors: exception.fieldErrors,
          timestamp: Date.now(),
        },
      };
    } else if (exception instanceof BudgetExceededException) {
      // 分支 2：LLM 预算超限异常 —— 固定 429 TOO_MANY_REQUESTS，携带安全的
      // 预算元数据 reason（不含 prompt/凭据）与任务 id。
      httpStatus = HttpStatus.TOO_MANY_REQUESTS;
      errorResponse = {
        error: {
          code: exception.code,
          message: exception.message,
          reason: exception.reason,
          taskId: exception.taskId,
          timestamp: Date.now(),
        },
      };
    } else if (exception instanceof HttpException) {
      // 分支 3：标准 Nest HTTP 异常（如 NotFoundException、UnauthorizedException）。
      httpStatus = exception.getStatus() as HttpStatus;
      const exceptionResponse = exception.getResponse();

      errorResponse = {
        error: {
          // 状态码反向映射回业务码；消息优先取字符串形式的响应体。
          code: HTTP_STATUS_TO_RESPONSE_CODE_MAP[httpStatus],
          message: typeof exceptionResponse === 'string' ? exceptionResponse : exception.message,
          details:
            typeof exceptionResponse === 'object' ? JSON.stringify(exceptionResponse) : undefined,
          timestamp: Date.now(),
        },
      };
    } else if (
      typeof exception === 'object' &&
      exception !== null &&
      (exception as { code?: unknown }).code === '22P02'
    ) {
      // 分支 4：Postgres 22P02 = invalid_text_representation —— 某个路径/查询
      // 值与列类型不匹配（最常见是畸形 UUID）。把它折叠成与"格式正确但缺失"
      // 相同的"资源不存在"语义，避免 500 噪音。
      httpStatus = HttpStatus.NOT_FOUND;
      errorResponse = {
        error: {
          code: ResponseCode.NOT_FOUND,
          // 注意：返回给客户端的文案是中文（既有行为，保持不变）。
          message: '资源不存在',
          timestamp: Date.now(),
        },
      };
    } else {
      // 分支 5：未知/未预期异常 —— 以 500 暴露，并附带诊断信息（stack/cause）。
      httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
      errorResponse = {
        error: {
          code: ResponseCode.INTERNAL_ERROR,
          // 注意：返回给客户端的文案是中文（既有行为，保持不变）。
          message: '服务器内部错误',
          stack: (exception as Error).stack,
          cause: (exception as Error).cause as string,
          timestamp: Date.now(),
        },
      };
    }

    // 统一按选定状态码写出 JSON 错误信封。
    response.status(httpStatus).json(errorResponse);
  }
}
