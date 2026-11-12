import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { getPgPool } from '../shared/db/index.js';
import { getBool } from '../shared/config/settings.js';
import { sendEmail } from '../shared/email/index.js';
import { createLogger } from '../shared/logger/index.js';
import { receiptDir, receiptPath } from '../shared/applications/receipts.js';
import { summaryHtml, type SummaryInput } from '../shared/applications/summary-html.js';

const logger = createLogger('submission-summary');

/**
 * After the site confirmed: a one-page PDF of what was sent (answers and where each came from, the site's own
 * confirmation, its screenshot), saved for the owner and emailed to them. Best effort — never fails the run.
 * Returns the PDF path, or null.
 */
export async function saveSubmissionSummary(
  page: Page,
  run: { jobId: string; userId: string; confirmation: string | null; reference: string | null },
  info: Omit<SummaryInput, 'submittedAt' | 'receiptPng' | 'confirmation' | 'reference'>,
): Promise<string | null> {
  const path = receiptPath(run.jobId, 'summaries');
  if (!path) return null;
  let sheet: Page | null = null;
  try {
    const png = await readFile(receiptPath(run.jobId, 'receipts') ?? '').catch(() => null);
    const html = summaryHtml({ ...info, submittedAt: new Date(), confirmation: run.confirmation, reference: run.reference, receiptPng: png?.toString('base64') ?? null });
    // A fresh blank tab in the same browser: the application page itself is left untouched.
    sheet = await page.context().newPage();
    await sheet.setContent(html, { waitUntil: 'load', timeout: 15_000 });
    const pdf = await sheet.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' } });
    await mkdir(receiptDir('summaries'), { recursive: true, mode: 0o700 });
    await writeFile(path, pdf, { mode: 0o600 });
  } catch (err) {
    logger.warn('summary:pdf-failed', { jobId: run.jobId, error: (err as Error).message });
    return null;
  } finally {
    await sheet?.close().catch(() => {});
  }
  // Mail it to the person's own address (their account email, not the one used on the site).
  try {
    if (await getBool('notify.email_summary')) {
      const { rows } = await getPgPool().query('SELECT email FROM users WHERE id::text = $1', [run.userId]);
      const to = rows[0]?.email as string | undefined;
      if (to) {
        const what = `${info.title}${info.company ? ` at ${info.company}` : ''}`;
        await sendEmail(
          to,
          `Submitted: ${what}`,
          `Your application for ${what} was submitted and the site confirmed it${run.reference ? ` (reference ${run.reference})` : ''}.\n\nThe attached PDF lists everything that was sent, and where each answer came from.\n\n— JobPilot`,
          [{ filename: 'application-summary.pdf', path }],
        );
      }
    }
  } catch (err) {
    logger.warn('summary:email-failed', { jobId: run.jobId, error: (err as Error).message });
  }
  return path;
}
