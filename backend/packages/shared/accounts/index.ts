import { getPgPool } from '../db/index.js';
import { deleteObject } from '../storage/index.js';
import { applicationsService } from '../applications/index.js';

// ============================================================
// ACCOUNTS — data export and permanent deletion of an end-user account
// (app-store / privacy requirements). Used by the user API (self-service)
// and the admin service.
// ============================================================

export const accountsService = {
  /** Everything we hold about the user, as one JSON document (data export). */
  async exportData(userId: string): Promise<Record<string, unknown>> {
    const pool = getPgPool();
    const q = async (sql: string) => (await pool.query(sql, [userId]).catch(() => ({ rows: [] as unknown[] }))).rows;
    const [profile, profileVersions, answers, applications, events, saved, emails, files, ledger, notifications, devices] = await Promise.all([
      q('SELECT data, version, onboarding_status, updated_at FROM profiles WHERE user_id = $1'),
      q('SELECT version, data, source, created_at FROM profile_versions WHERE user_id = $1 ORDER BY version'),
      q('SELECT question, answer, source, updated_at FROM answer_memory WHERE user_id = $1'),
      q(`SELECT id, title, company, url, status, status_detail, reference, error, created_at, updated_at, finished_at
           FROM applications WHERE user_id = $1 ORDER BY created_at`),
      q(`SELECT e.application_id, e.phase, e.detail, e.at FROM application_events e
           JOIN applications a ON a.id = e.application_id WHERE a.user_id = $1 ORDER BY e.at`),
      q('SELECT job_id, created_at FROM saved_jobs WHERE user_id = $1'),
      q(`SELECT from_name, from_address, to_address, subject, body_text, category, received_at
           FROM emails WHERE user_id = $1 ORDER BY received_at`),
      q(`SELECT id, category, original_name, mime_type, file_size_bytes, created_at FROM user_files WHERE user_id = $1`),
      q('SELECT delta, reason, note, balance_after, created_at FROM credit_ledger WHERE user_id = $1 ORDER BY id'),
      q('SELECT kind, title, body, data, read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at'),
      q('SELECT platform, app_version, created_at, last_seen_at FROM push_devices WHERE user_id = $1'),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      account: (await pool.query(
        'SELECT id, email, email_verified, mobile_number, mobile_verified, google_id, display_name, created_at, last_login_at FROM users WHERE id::text = $1',
        [userId],
      )).rows[0] ?? null,
      profile: profile[0] ?? null,
      profileVersions,
      rememberedAnswers: answers,
      applications,
      applicationEvents: events,
      savedJobs: saved,
      inbox: emails,
      files,
      credits: ledger,
      notifications,
      devices,
    };
  },

  /**
   * Permanently delete the account and everything tied to it. Logs keep
   * their rows for cost/abuse accounting with the user id removed.
   * Running applications are cancelled first so nothing is submitted afterwards.
   */
  async deleteAccount(userId: string): Promise<{ files: number }> {
    for (const a of await applicationsService.list(userId, 'all', 200)) {
      if (['queued', 'running', 'needs_input', 'awaiting_review'].includes(a.status)) {
        await applicationsService.cancel(userId, a.id).catch(() => {});
      }
    }
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const exists = async (table: string) =>
        (await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [table])).rows[0].ok as boolean;
      const { rows: files } = await client.query('SELECT storage_path FROM user_files WHERE user_id = $1', [userId]);
      for (const table of [
        'notifications', 'push_devices', 'credit_ledger', 'emails', 'inbox_addresses', 'applications',
        'saved_jobs', 'job_feedback', 'resume_parses', 'answer_memory', 'profile_versions', 'profiles',
        'user_secrets', 'user_captcha_usage', 'user_profiles', 'sessions', 'user_files',
      ]) {
        if (await exists(table)) await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
      }
      for (const table of ['job_logs', 'observability_events', 'error_reports', 'human_intervention_events', 'llm_usage']) {
        if (await exists(table)) await client.query(`UPDATE ${table} SET user_id = NULL WHERE user_id = $1`, [userId]);
      }
      await client.query('DELETE FROM users WHERE id::text = $1', [userId]);
      await client.query('COMMIT');
      // Blobs after the commit: a failed delete leaves an orphan, never a dangling row.
      for (const f of files) await deleteObject(f.storage_path as string).catch(() => {});
      return { files: files.length };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};
