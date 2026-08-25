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
}

const SELECT = `
  id,
  email,
  email_verified as "emailVerified",
  mobile_number as "mobileNumber",
  mobile_verified as "mobileVerified",
  google_id as "googleId",
  display_name as "displayName"
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
    const { rows } = await pool.query(
      `
      INSERT INTO users (google_id, email, email_verified, display_name, last_login_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (google_id) DO UPDATE SET
        email = EXCLUDED.email,
        email_verified = EXCLUDED.email_verified,
        display_name = COALESCE(EXCLUDED.display_name, users.display_name),
        last_login_at = NOW()
      RETURNING ${SELECT}
      `,
      [input.googleId, input.email, input.emailVerified, input.displayName ?? null]
    );
    return rows[0];
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
};
