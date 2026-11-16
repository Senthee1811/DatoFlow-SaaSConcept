import type { Page, PageQuery } from '@datoflow/shared';

/** Prisma arguments for cursor pagination. Fetches one extra row to know if there is a next page. */
export function pageArgs(query: PageQuery) {
  return {
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  };
}

export function toPage<T extends { id: string }, D>(
  rows: T[],
  query: PageQuery,
  map: (row: T) => D,
): Page<D> {
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  return { items: items.map(map), nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}
