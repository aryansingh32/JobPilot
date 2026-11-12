import { getPgPool } from '../shared/db/index.js';

// ============================================================
// USER ACCOUNT SERVICE — real end-user identities (Google /
// email-OTP / mobile-OTP). This replaces the old model where any
// client could just supply an arbitrary `userId` string.
// ============================================================

export interface UserAccount {
  id: string;
  email: string | null;
  emailVerified: boolean;
  mobileNumber: string | null;
  mobileVerified: boolean;
  googleId: string | null;
  displayName: string | null;
  suspended: boolean;
}

const SELECT = `
  id,
  email,
  email_verified as "emailVerified",
  mobile_number as "mobileNumber",
  mobile_verified as "mobileVerified",
  google_id as "googleId",
  display_name as "displayName",
  (suspended_at IS NOT NULL) as "suspended"
`;

export const userAccountService = {
  async findById(id: string): Promise<UserAccount | null> {
    const pool = getPgPool();
    const { rows } = await pool.query(`SELECT ${SELECT} FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async upsertGoogleUser(input: {
    googleId: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
  }): Promise<UserAccount> {
    const pool = getPgPool();
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName ?? null;

    // Returning Google user.
    const byGoogle = await pool.query(
      `UPDATE users SET email = $2, email_verified = $3,
         display_name = COALESCE($4, display_name), last_login_at = NOW()
       WHERE google_id = $1 RETURNING ${SELECT}`,
      [input.googleId, email, input.emailVerified, displayName]
    );
    if (byGoogle.rows[0]) return byGoogle.rows[0];

    // Same person who signed in earlier by email OTP: attach the Google identity.
    // Only when Google vouches for the address, otherwise anyone could claim it.
    if (input.emailVerified) {
      const byEmail = await pool.query(
        `UPDATE users SET google_id = $1, email_verified = true,
           display_name = COALESCE(display_name, $3), last_login_at = NOW()
         WHERE email = $2 AND google_id IS NULL RETURNING ${SELECT}`,
        [input.googleId, email, displayName]
      );
      if (byEmail.rows[0]) return byEmail.rows[0];
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO users (google_id, email, email_verified, display_name, last_login_at)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING ${SELECT}`,
        [input.googleId, email, input.emailVerified, displayName]
      );
      return rows[0];
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      // Two sign-ins at once: the other one created the row first, so this is the same person.
      const again = await pool.query(`SELECT ${SELECT} FROM users WHERE google_id = $1`, [input.googleId]);
      if (again.rows[0]) return again.rows[0];
      // The address belongs to an account Google can't vouch for (different Google identity, or unverified).
      throw Object.assign(new Error('An account with this email already exists. Sign in the way you used before.'), { statusCode: 409 });
    }
  },

  async upsertEmailUser(email: string): Promise<UserAccount> {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `
      INSERT INTO users (email, email_verified, last_login_at)
      VALUES ($1, true, NOW())
      ON CONFLICT (email) DO UPDATE SET
        email_verified = true,
        last_login_at = NOW()
      RETURNING ${SELECT}
      `,
      [email.trim().toLowerCase()]
    );
    return rows[0];
  },

  async upsertMobileUser(mobileNumber: string): Promise<UserAccount> {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `
      INSERT INTO users (mobile_number, mobile_verified, last_login_at)
      VALUES ($1, true, NOW())
      ON CONFLICT (mobile_number) DO UPDATE SET
        mobile_verified = true,
        last_login_at = NOW()
      RETURNING ${SELECT}
      `,
      [mobileNumber.trim()]
    );
    return rows[0];
  },

  /**
   * Attach a verified mobile number to an existing (e.g. email/Google) account.
   * Returns null when the number already belongs to a different account.
   */
  async linkMobile(userId: string, mobileNumber: string): Promise<UserAccount | null> {
    const pool = getPgPool();
    const number = mobileNumber.trim();
    const { rows: owners } = await pool.query(
      `SELECT id FROM users WHERE mobile_number = $1 AND id <> $2`,
      [number, userId]
    );
    if (owners.length) return null;
    const { rows } = await pool.query(
      `UPDATE users SET mobile_number = $2, mobile_verified = true WHERE id = $1 RETURNING ${SELECT}`,
      [userId, number]
    );
    return rows[0] ?? null;
  },
};
