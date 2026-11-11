/**
 * Global exception filter.
 *
 * Catches every unhandled exception thrown anywhere in the request lifecycle and
 * normalizes it into the standard `ApiErrorResponse` JSON envelope, selecting the
 * HTTP status and business `ResponseCode` based on the exception type:
 *   1. `BusinessException`   -> its own code/message/httpStatus.
 *   2. Nest `HttpException`  -> status mapped back to a `ResponseCode`.
 *   3. Postgres error `22P02` (invalid text representation, e.g. malformed UUID)
 *      -> treated as 404 NOT_FOUND so a bad UUID reads as "resource missing"
 *         rather than a 500.
 *   4. Anything else         -> generic 500 INTERNAL_ERROR without internal details.
 * Registered as `APP_FILTER` in `AppModule`.
 */
import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { BusinessException } from '../interfaces/exception.interface';
import { HTTP_STATUS_TO_RESPONSE_CODE_MAP, ResponseCode } from '../constants/api_response_code';
import { ApiErrorResponse } from '../interfaces/api_response.interface';
import { BudgetExceededException } from '../../modules/llm-budget/llm-budget.rules';
import { safeTeamErrorResponse, safeStandardHttpDetails } from './team-error-response';

/**
 * Catch-all exception filter that turns exceptions into the unified error JSON
 * body. It never throws; it always writes a response (unless headers were already
 * sent).
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  /**
   * Handles a single thrown exception for the current HTTP request.
   *
   * @param exception The thrown value of any type.
   * @param host      Nest arguments host, used to extract the Express response.
   */
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // If the response has already been committed, we cannot safely write again.
    if (response.headersSent) {
      return;
    }

    let errorResponse: Omit<ApiErrorResponse, 'httpStatus'>;
    let httpStatus: HttpStatus;

    if (exception instanceof BusinessException) {
      // Domain-level business exception: trust its explicit code/message/status.
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
      // Standard Nest HTTP exception (e.g. NotFoundException, UnauthorizedException).
      httpStatus = exception.getStatus() as HttpStatus;
      const exceptionResponse = exception.getResponse();

      const teamError = safeTeamErrorResponse(exceptionResponse);
      errorResponse = { error: teamError
        ? { ...teamError, timestamp: Date.now() }
        : { code: HTTP_STATUS_TO_RESPONSE_CODE_MAP[httpStatus] ?? ResponseCode.INTERNAL_ERROR,
          message: httpStatus >= 500 ? '服务器内部错误'
            : (typeof exceptionResponse === 'string' ? exceptionResponse : exception.message),
          details: safeStandardHttpDetails(exceptionResponse, httpStatus),
          timestamp: Date.now() } };
    } else if (
      typeof exception === 'object' &&
      exception !== null &&
      (exception as { code?: unknown }).code === '22P02'
    ) {
      // Postgres 22P02 = invalid_text_representation: a path/query value did not
      // match a column type (most often a malformed UUID). We fold it into the
      // same "not found" semantics as a well-formed-but-missing UUID to avoid 500 noise.
      httpStatus = HttpStatus.NOT_FOUND;
      errorResponse = {
        error: {
          code: ResponseCode.NOT_FOUND,
          // NOTE: Chinese user-facing message returned to the client (existing behavior).
          message: '资源不存在',
          timestamp: Date.now(),
        },
      };
    } else {
      // Unknown failures expose a generic response. Internal stacks and causes
      // may contain database parameters, credentials or private research text.
      httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
      errorResponse = {
        error: {
          code: ResponseCode.INTERNAL_ERROR,
          // NOTE: Chinese user-facing message returned to the client (existing behavior).
          message: '服务器内部错误',
          timestamp: Date.now(),
        },
      };
    }

    response.status(httpStatus).json(errorResponse);
  }
}
