import { getPgPool } from '../db/index.js';
import { cryptoService } from '../crypto/index.js';

// ============================================================
// PORTAL PASSWORD — one password the user chooses themselves, used when the
// bot has to create an account on an employer's applicant portal (Workday,
// iCIMS, Oracle…) and tried first when it has to sign in. The user can always
// sign in to those portals by hand with it. Stored encrypted (AES-256-GCM),
// never returned by the API, never written to logs or answer memory.
// Without one, accounts get a random per-site password as before.
// ============================================================

const KEY = 'portal:password';

/** Why a password won't do, or null. Rules are the intersection of what Workday / iCIMS / Oracle accept. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 64) return 'Use 64 characters or fewer.';
  if (/\s/.test(pw)) return "Don't use spaces.";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return 'Mix upper- and lower-case letters.';
  if (!/\d/.test(pw)) return 'Include at least one number.';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Include at least one symbol (for example ! or #).';
  return null;
}

export const portalPassword = {
  async has(userId: string): Promise<boolean> {
    const { rows } = await getPgPool().query('SELECT 1 FROM user_secrets WHERE user_id = $1 AND site_id IS NULL AND key_name = $2', [userId, KEY]);
    return rows.length > 0;
  },

  async get(userId: string): Promise<string | null> {
    const { rows } = await getPgPool().query(
      'SELECT encrypted_value FROM user_secrets WHERE user_id = $1 AND site_id IS NULL AND key_name = $2',
      [userId, KEY],
    );
    return rows[0] ? cryptoService.decrypt(rows[0].encrypted_value) : null;
  },

  /** site_id is NULL for a user-wide secret, which the unique constraint doesn't cover — replace explicitly. */
  async set(userId: string, password: string): Promise<void> {
    const pool = getPgPool();
    await pool.query('DELETE FROM user_secrets WHERE user_id = $1 AND site_id IS NULL AND key_name = $2', [userId, KEY]);
    await pool.query('INSERT INTO user_secrets (user_id, site_id, key_name, encrypted_value) VALUES ($1, NULL, $2, $3)', [
      userId,
      KEY,
      cryptoService.encrypt(password),
    ]);
  },

  async clear(userId: string): Promise<void> {
    await getPgPool().query('DELETE FROM user_secrets WHERE user_id = $1 AND site_id IS NULL AND key_name = $2', [userId, KEY]);
  },
};
