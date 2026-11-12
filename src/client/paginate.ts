export interface OffsetPage<T> {
  items: T[];
  total?: number;
}

/**
 * Collects all items from an offset/limit paginated endpoint.
 * Stops when `total` is reached, a page is empty, or `maxItems` is hit.
 */
export async function collectByOffset<T>(
  fetchPage: (offset: number, limit: number) => Promise<OffsetPage<T>>,
  opts: { limit?: number; maxItems?: number } = {},
): Promise<{ items: T[]; total?: number; truncated: boolean }> {
  const limit = opts.limit ?? 100;
  const max = opts.maxItems ?? Number.POSITIVE_INFINITY;
  const items: T[] = [];
  let offset = 0;
  let total: number | undefined;
  for (;;) {
    const page = await fetchPage(offset, limit);
    total = page.total ?? total;
    items.push(...page.items);
    offset += page.items.length;
    if (items.length >= max) {
      return { items: items.slice(0, max), total, truncated: true };
    }
    if (page.items.length === 0 || (total !== undefined && offset >= total)) {
      return { items, total, truncated: false };
    }
    if (total === undefined && page.items.length < limit) {
      return { items, total, truncated: false };
    }
  }
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
  hasMore?: boolean;
}

/** Collects items from a cursor paginated endpoint, up to `maxItems`. */
export async function collectByCursor<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
  opts: { maxItems?: number; startCursor?: string } = {},
): Promise<{ items: T[]; nextCursor?: string; hasMore: boolean }> {
  const max = opts.maxItems ?? Number.POSITIVE_INFINITY;
  const items: T[] = [];
  let cursor = opts.startCursor;
  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    const more = Boolean(page.hasMore && page.nextCursor);
    if (!more) return { items, hasMore: false };
    cursor = page.nextCursor;
    if (items.length >= max) return { items, nextCursor: cursor, hasMore: true };
  }
}
