/**
 * Unified error response envelope.
 *
 * Every failed API response is serialized as this shape by `GlobalExceptionFilter`,
 * so the frontend always receives `{ error: { code, message, ... } }` regardless
 * of the underlying exception type.
 */
export interface ApiErrorResponse {
  /** Wrapped error payload. */
  error: {
    /** Stable business error code (see `ResponseCode`). */
    code: string;
    /** Human-readable error message. */
    message: string;
    /** Additional structured detail (often a JSON string). */
    details?: string;
    /** Safe budget metadata, without prompts or provider credentials. */
    reason?: string;
    taskId?: string;
    /** Per-field validation errors, keyed by field name. */
    fieldErrors?: Record<string, string[]>;
    /** Allowlisted team conflict metadata; never raw exception bodies. */
    actualRevision?: number;
    field?: string;
    roleId?: string;
    relationId?: string;
    retryable?: boolean;
    /** Unix-millisecond timestamp of when the error occurred. */
    timestamp?: number;
  };
}

