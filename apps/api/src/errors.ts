/**
 * Errors
 * ------
 * Anything thrown from a route is caught by the error-handler middleware and
 * mapped to a JSON response. Throw `AppError` for expected failures
 * (validation, auth, not-found, rate-limit). Anything else is treated as
 * 500 Internal — its message is hidden in production and logged at error.
 *
 * Error JSON shape:
 *   { "error": { "code": "<code>", "message": "<human readable>", "details": { ... } } }
 */

export type ErrorCode =
  // 400
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  // 401
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  // 403
  | 'FORBIDDEN'
  | 'MISSING_PERMISSIONS'
  | 'TIMED_OUT'
  // 403 — member is still in onboarding 'pending' state and hasn't
  // acknowledged the guild's rules. Distinct from MISSING_PERMISSIONS
  // because the resolution is "go read the rules and click accept,"
  // not "ask an admin for elevated permissions."
  | 'PENDING_ACKNOWLEDGMENT'
  // 400 — content rejected by guild automod rule. Distinct from
  // generic VALIDATION_FAILED so clients can render specific UI
  // ("Your message matched a server moderation rule") and surface
  // the rule name. The action might also have applied a timeout to
  // the sender; the client should refresh member state on receiving
  // this code.
  | 'AUTOMOD_BLOCKED'
  // 404
  | 'NOT_FOUND'
  // 409
  | 'CONFLICT'
  | 'ALREADY_EXISTS'
  // 410
  | 'GONE'
  // 413
  | 'PAYLOAD_TOO_LARGE'
  // 415
  | 'UNSUPPORTED_MEDIA_TYPE'
  // 422
  | 'UNPROCESSABLE'
  // 429
  | 'RATE_LIMITED'
  // 5xx
  | 'INTERNAL'
  | 'NOT_IMPLEMENTED'
  | 'UPSTREAM_FAILED'
  | 'SERVICE_UNAVAILABLE';

const STATUS_FOR: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  MISSING_PERMISSIONS: 403,
  TIMED_OUT: 403,
  PENDING_ACKNOWLEDGMENT: 403,
  AUTOMOD_BLOCKED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_FAILED: 502,
  SERVICE_UNAVAILABLE: 503,
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_FOR[code];
    this.details = details;
  }

  toResponseBody(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

// Convenience constructors. Match the most common cases at call sites.
export const errors = {
  badRequest: (message: string, details?: Record<string, unknown>) =>
    new AppError('BAD_REQUEST', message, details),
  validation: (details: Record<string, unknown>) =>
    new AppError('VALIDATION_FAILED', 'Request validation failed', details),
  unauthenticated: (message = 'Authentication required') =>
    new AppError('UNAUTHENTICATED', message),
  tokenExpired: (message = 'Access token has expired') =>
    new AppError('TOKEN_EXPIRED', message),
  tokenInvalid: (message = 'Access token is invalid') =>
    new AppError('TOKEN_INVALID', message),
  invalidCredentials: () =>
    new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect'),
  forbidden: (message = 'Forbidden') => new AppError('FORBIDDEN', message),
  missingPermissions: (required: string[]) =>
    new AppError('MISSING_PERMISSIONS', 'Missing required permissions', { required }),
  /**
   * The caller is currently timed out in the guild. The detail
   * carries the until-timestamp so the client can render a concrete
   * countdown / wait-until prompt instead of a vague "you can't do
   * that." Distinct from MISSING_PERMISSIONS because the underlying
   * cause is moderator action, not a permission gap — the UX hint
   * the client should show is different.
   */
  timedOut: (until: Date) =>
    new AppError(
      'TIMED_OUT',
      'You have been timed out in this server',
      { until: until.toISOString() },
    ),
  /**
   * The member is still in onboarding 'pending' state. The client
   * should surface the rules-acknowledgment prompt rather than
   * showing a generic permission error.
   */
  pendingAcknowledgment: () =>
    new AppError(
      'PENDING_ACKNOWLEDGMENT',
      'You need to acknowledge the server rules first',
    ),
  /**
   * The message matched a server automod rule. The detail carries
   * the rule name so the UI can show which rule fired, and a flag
   * for whether the matching action also issued a timeout to the
   * sender (in which case the client should refresh member state).
   */
  automodBlocked: (ruleName: string, timeoutApplied: boolean) =>
    new AppError(
      'AUTOMOD_BLOCKED',
      'Message blocked by server moderation rule',
      { ruleName, timeoutApplied },
    ),
  notFound: (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`),
  conflict: (message: string, details?: Record<string, unknown>) =>
    new AppError('CONFLICT', message, details),
  alreadyExists: (what: string) => new AppError('ALREADY_EXISTS', `${what} already exists`),
  payloadTooLarge: (message = 'Payload too large') =>
    new AppError('PAYLOAD_TOO_LARGE', message),
  rateLimited: (retryAfterSeconds?: number) =>
    new AppError(
      'RATE_LIMITED',
      'Too many requests',
      retryAfterSeconds != null ? { retryAfterSeconds } : undefined,
    ),
  internal: (message = 'Internal server error') => new AppError('INTERNAL', message),
  serviceUnavailable: (message = 'Service unavailable') =>
    new AppError('SERVICE_UNAVAILABLE', message),
};
