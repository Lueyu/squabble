/**
 * 业务响应码及其到 HTTP 状态码的映射。
 *
 * 职责边界：只定义"业务码枚举 + 双向映射表"；不做序列化、不抛异常。
 *
 * 上下游：import HttpStatus（@nestjs/common）；被全局异常过滤器
 * （exception.filter.ts）、BusinessException 等引用，为每个 API 响应体提供
 * 稳定、语言无关的字符串 `code`（如 `NOT_FOUND`），前端据此按业务语义分支，
 * 而不必只依赖 HTTP 状态码。
 *
 * 关键约定：
 * - 正向映射：业务码 -> HTTP 状态码；反向映射：HTTP 状态码 -> 业务码；
 * - 注意 VALIDATION_ERROR 与 BUSINESS_ERROR 都映射到 HTTP 422
 *   (Unprocessable Entity)，而不是笼统的 400；
 * - 反向映射由正向映射自动推导，两表必须保持单一来源。
 */
import { HttpStatus } from '@nestjs/common';

/**
 * 规范的业务结果码，出现在每个 API 响应体的 `error.code` / 成功信封里。
 * 按成功、客户端错误、服务端错误、通用业务错误分组。
 */
export enum ResponseCode {
  // 成功类。
  SUCCESS = 'SUCCESS',
  CREATED = 'CREATED',
  ACCEPTED = 'ACCEPTED',
  NO_CONTENT = 'NO_CONTENT',

  // 客户端错误类。
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  CONFLICT = 'CONFLICT',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',

  // 服务端错误类。
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  BAD_GATEWAY = 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // 通用领域级错误。
  BUSINESS_ERROR = 'BUSINESS_ERROR',
}

/**
 * 正向映射：每个业务 `ResponseCode` 对应应返回的 HTTP 状态码。
 * 注意：VALIDATION_ERROR 与 BUSINESS_ERROR 都映射到 HTTP 422
 * （Unprocessable Entity），而非笼统的 400。
 */
export const RESPONSE_CODE_TO_HTTP_STATUS_MAP: Record<ResponseCode, number> = {
  [ResponseCode.SUCCESS]: HttpStatus.OK,
  [ResponseCode.CREATED]: HttpStatus.CREATED,
  [ResponseCode.ACCEPTED]: HttpStatus.ACCEPTED,
  [ResponseCode.NO_CONTENT]: HttpStatus.NO_CONTENT,

  [ResponseCode.BAD_REQUEST]: HttpStatus.BAD_REQUEST,
  [ResponseCode.UNAUTHORIZED]: HttpStatus.UNAUTHORIZED,
  [ResponseCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ResponseCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ResponseCode.VALIDATION_ERROR]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ResponseCode.CONFLICT]: HttpStatus.CONFLICT,
  [ResponseCode.TOO_MANY_REQUESTS]: HttpStatus.TOO_MANY_REQUESTS,

  [ResponseCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ResponseCode.BAD_GATEWAY]: HttpStatus.BAD_GATEWAY,
  [ResponseCode.SERVICE_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,

  [ResponseCode.BUSINESS_ERROR]: HttpStatus.UNPROCESSABLE_ENTITY, // 通用业务错误的状态码。
};

/**
 * 反向映射：由 `RESPONSE_CODE_TO_HTTP_STATUS_MAP` 自动推导生成。
 * 全局异常过滤器用它把抛出的 `HttpStatus` 翻译回业务 `ResponseCode`。
 */
export const HTTP_STATUS_TO_RESPONSE_CODE_MAP: Record<number, ResponseCode> = Object.fromEntries(
  Object.entries(RESPONSE_CODE_TO_HTTP_STATUS_MAP).map(([code, status]) => [
    status,
    code as ResponseCode,
  ]),
) as Record<number, ResponseCode>;
