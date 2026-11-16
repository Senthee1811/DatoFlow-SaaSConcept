import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { idParam } from '@datoflow/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import { ApiError, zodToApiError } from './errors.js';

function parse<S extends z.ZodType>(schema: S, value: unknown, prefix?: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw zodToApiError(result.error, prefix);
  return result.data;
}

// Nest treats a decorator argument with a `transform` method as a pipe, and Zod schemas have one,
// so the schema travels wrapped in an object. The key is not `schema`, which Nest 12 reads as its own option.
type Wrapped = { zod: z.ZodType };

const BodyParam = createParamDecorator(({ zod }: Wrapped, ctx: ExecutionContext) =>
  parse(zod, ctx.switchToHttp().getRequest<Request>().body ?? {}, 'body'),
);
const QueryParam = createParamDecorator(({ zod }: Wrapped, ctx: ExecutionContext) =>
  parse(zod, { ...ctx.switchToHttp().getRequest<Request>().query }, 'query'),
);

/** The request body, parsed by a strict Zod schema. Unknown fields are a 422 (NFR-SEC-02). */
export const ZBody = (schema: z.ZodType) => BodyParam({ zod: schema });

/** The query string, parsed by a strict Zod schema. */
export const ZQuery = (schema: z.ZodType) => QueryParam({ zod: schema });

/**
 * A path id. A malformed id is a 404, the same answer as an id that does not exist,
 * so an id never reveals anything about another organization.
 */
export const IdParam = createParamDecorator((name: string, ctx: ExecutionContext) => {
  const raw = ctx.switchToHttp().getRequest<Request>().params[name];
  const result = idParam.safeParse(raw);
  if (!result.success) throw ApiError.notFound();
  return result.data;
});
