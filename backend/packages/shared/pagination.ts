// Clamp/validate untrusted `limit`/`offset` query params before they reach a
// SQL LIMIT/OFFSET clause. Postgres rejects a negative LIMIT/OFFSET and a
// NaN parameter outright, which previously surfaced as a raw 500 on any
// admin list endpoint given a non-numeric or negative value.
export function parsePagination(
  query: { limit?: string; offset?: string },
  defaults: { limit: number; maxLimit: number } = { limit: 50, maxLimit: 500 }
): { limit: number; offset: number } {
  const parsedLimit = Number.parseInt(query.limit ?? '', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, defaults.maxLimit)
    : defaults.limit;

  const parsedOffset = Number.parseInt(query.offset ?? '', 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

  return { limit, offset };
}

// Same idea for a bare `limit` used against a Redis lRange(-limit, -1) call
// (e.g. tailing the last N log lines) rather than SQL.
export function parseListLimit(rawLimit: string | undefined, fallback: number, max = 5000): number {
  const parsed = Number.parseInt(rawLimit ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
