import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ErrorCode, type ProblemDocument } from '@datoflow/shared';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Sign in required',
  402: 'Plan limit reached',
  403: 'Not allowed',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Payload too large',
  422: 'Validation failed',
  429: 'Too many requests',
  500: 'Something went wrong',
  503: 'Service unavailable',
};

/** An error the API means to return. Anything else becomes a 500 with no detail. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    detail?: string,
    readonly extra: Partial<Pick<ProblemDocument, 'errors' | 'limit' | 'reason' | 'ids'>> = {},
  ) {
    super(detail ?? TITLES[status] ?? 'Error');
  }

  static notFound(what = 'Resource') {
    return new ApiError(404, ErrorCode.NOT_FOUND, `${what} not found`);
  }
  static forbidden(detail = 'Your role does not allow this') {
    return new ApiError(403, ErrorCode.FORBIDDEN, detail);
  }
  static validation(errors: { path: string; message: string }[]) {
    return new ApiError(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid', { errors });
  }
}

export function zodToApiError(error: ZodError, prefix?: string): ApiError {
  return ApiError.validation(
    error.issues.map((i) => ({
      path: [prefix, ...i.path.map(String)].filter(Boolean).join('.') || '(root)',
      message: i.message,
    })),
  );
}

function statusCodeFor(status: number): ErrorCode {
  switch (status) {
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
    case 405:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return status < 500 ? ErrorCode.VALIDATION_FAILED : ErrorCode.INTERNAL;
  }
}

/** Renders every error as RFC 9457 application/problem+json. */
export function toProblem(error: unknown, req: Request): ProblemDocument {
  let status = 500;
  let code: ErrorCode = ErrorCode.INTERNAL;
  let detail: string | undefined;
  let extra: ApiError['extra'] = {};

  if (error instanceof ApiError) {
    ({ status, code, extra } = error);
    detail = error.message;
  } else if (error instanceof ZodError) {
    const api = zodToApiError(error);
    ({ status, code, extra } = api);
    detail = api.message;
  } else if (error instanceof HttpException) {
    status = error.getStatus();
    code = statusCodeFor(status);
    // Body-parser errors (malformed JSON, oversize) come through here as 400 and 413.
    detail = status < 500 ? error.message : undefined;
  } else if (isPrismaUniqueViolation(error)) {
    status = 409;
    code = ErrorCode.CONFLICT;
    detail = 'A record with these values already exists';
  } else if (isHttpError(error)) {
    status = error.status;
    code = statusCodeFor(status);
    detail = status < 500 ? error.message : undefined;
  }

  return {
    type: `https://datoflow.app/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLES[status] ?? 'Error',
    status,
    code,
    ...(detail ? { detail } : {}),
    instance: req.originalUrl,
    requestId: String(req.id ?? ''),
    ...extra,
  };
}

function isPrismaUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

function isHttpError(e: unknown): e is { status: number; message: string } {
  const s = (e as { status?: unknown; statusCode?: unknown } | null)?.status;
  return typeof s === 'number' && s >= 400 && s < 600 && e instanceof Error;
}

export function sendProblem(res: Response, problem: ProblemDocument) {
  if (problem.status === 429 && !res.getHeader('retry-after')) res.setHeader('retry-after', '60');
  res.status(problem.status).type('application/problem+json').json(problem);
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const problem = toProblem(error, req);
    if (problem.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      req.log?.error({ err: error }, 'unhandled error');
    }
    sendProblem(res, problem);
  }
}
