import type { ProblemDocument } from '@datoflow/shared';

/** An RFC 9457 problem returned by the API. */
export class ApiProblem extends Error {
  constructor(readonly problem: ProblemDocument) {
    super(problem.detail ?? problem.title);
  }

  get status() {
    return this.problem.status;
  }

  /** Field errors keyed by the field name, without the `body.` prefix. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(
      (this.problem.errors ?? []).map((e) => [e.path.replace(/^(body|query)\./, ''), e.message]),
    );
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const problem =
      data && typeof data === 'object' && 'status' in data
        ? (data as ProblemDocument)
        : ({
            type: 'about:blank',
            title: 'Something went wrong',
            status: res.status,
            code: 'INTERNAL',
          } as ProblemDocument);
    throw new ApiProblem(problem);
  }
  return data as T;
}

export function problemMessage(error: unknown): string {
  if (error instanceof ApiProblem) return error.message;
  return 'Something went wrong. Try again';
}
