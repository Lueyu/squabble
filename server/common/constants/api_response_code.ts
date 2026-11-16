/**
 * Business response codes and their mapping to HTTP status codes.
 *
 * The API uses a stable, language-independent string `code` (e.g. `NOT_FOUND`)
 * in every response body so the frontend can branch on business semantics without
 * relying on HTTP status alone. This module defines the canonical `ResponseCode`
 * enum, the forward map (business code -> HTTP status), and the reverse map
 * (HTTP status -> business code) used by the global exception filter.
 */
import { HttpStatus } from '@nestjs/common';

/**
 * Canonical business result codes returned in every API response body's
 * `error.code` / success envelope. Grouped by success, client error, server
 * error, and generic business error.
 */
export enum ResponseCode {
  // Successful outcomes.
  SUCCESS = 'SUCCESS',
  CREATED = 'CREATED',
  ACCEPTED = 'ACCEPTED',
  NO_CONTENT = 'NO_CONTENT',

  // Client-side errors.
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  CONFLICT = 'CONFLICT',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',

  // Server-side errors.
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  BAD_GATEWAY = 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // Generic domain-level error.
  BUSINESS_ERROR = 'BUSINESS_ERROR',
}

/**
 * Forward mapping from each business `ResponseCode` to the HTTP status code that
 * should accompany it. Note: `VALIDATION_ERROR` and `BUSINESS_ERROR` both map to
 * HTTP 422 (Unprocessable Entity) rather than a generic 400.
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

  [ResponseCode.BUSINESS_ERROR]: HttpStatus.UNPROCESSABLE_ENTITY, // Generic business error status.
};

/**
 * Reverse mapping derived automatically from
 * `RESPONSE_CODE_TO_HTTP_STATUS_MAP`. Used by the exception filter to translate
 * a thrown `HttpStatus` back into a business `ResponseCode`.
 */
export const HTTP_STATUS_TO_RESPONSE_CODE_MAP: Record<number, ResponseCode> = Object.fromEntries(
  Object.entries(RESPONSE_CODE_TO_HTTP_STATUS_MAP).map(([code, status]) => [
    status,
    code as ResponseCode,
  ]),
) as Record<number, ResponseCode>;
