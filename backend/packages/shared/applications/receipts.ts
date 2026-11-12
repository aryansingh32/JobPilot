import { join } from 'node:path';

// Where confirmation screenshots ("receipts") and failure screenshots live. The file name is the run's id and
// nothing else; the only way out of the process is the owner-checked /me/applications/:id/receipt route.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReceiptKind = 'receipts' | 'diagnostics' | 'summaries';

export function receiptDir(kind: ReceiptKind): string {
  return join(process.env.RECEIPTS_DIR ?? join(process.cwd(), '..', '.dev-data'), kind);
}

/** Absolute path for a run's screenshot, or null when the id isn't a run id (never builds a path from free text). */
export function receiptPath(execJobId: string | null | undefined, kind: ReceiptKind = 'receipts'): string | null {
  return execJobId && UUID.test(execJobId) ? join(receiptDir(kind), `${execJobId}.${kind === 'summaries' ? 'pdf' : 'png'}`) : null;
}
