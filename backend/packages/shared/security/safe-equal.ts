import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison (hashing first so lengths don't leak either). */
export function safeEqual(a: unknown, b: string | undefined): boolean {
  if (typeof a !== 'string' || !b) return false;
  const h = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(h(a), h(b));
}
