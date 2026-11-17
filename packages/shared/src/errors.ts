/** Stable error codes returned in RFC 9457 problem documents. Never rename one. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  SLUG_TAKEN: 'SLUG_TAKEN',
  LAST_OWNER: 'LAST_OWNER',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  INVITATION_INVALID: 'INVITATION_INVALID',
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  RATE_LIMITED: 'RATE_LIMITED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  LOSS_REASON_REQUIRED: 'LOSS_REASON_REQUIRED',
  DEAL_VALUE_REQUIRED: 'DEAL_VALUE_REQUIRED',
  STAGE_NOT_EMPTY: 'STAGE_NOT_EMPTY',
  INVALID_STAGES: 'INVALID_STAGES',
  NEXT_STEP_REQUIRED: 'NEXT_STEP_REQUIRED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** RFC 9457 problem document, as the API returns it. */
export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  instance?: string;
  requestId?: string;
  /** Field-level messages for 422 responses. */
  errors?: { path: string; message: string }[];
  /** Name of the plan limit for 402 responses. */
  limit?: string;
  /** Why an invitation cannot be accepted. */
  reason?: string;
  /** Records that block the request, such as stages that still hold leads. */
  ids?: string[];
}
