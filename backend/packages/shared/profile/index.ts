import { createHash } from 'crypto';
import { getPgPool, withTransaction } from '../db/index.js';

// ============================================================
// APPLICANT PROFILE — the single source every form is filled from.
// Typed, versioned, one per user. Partial updates deep-merge (arrays are
// replaced wholesale) so the UI can save one section at a time.
// ============================================================

export interface ProfileData {
  personal?: {
    fullName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    phoneVerified?: boolean;
    city?: string;
    state?: string;
    country?: string;
    address?: string;
    postalCode?: string;
    linkedin?: string;
    github?: string;
    website?: string;
    summary?: string;
  };
  work?: {
    experienceLevel?: string;
    currentEmployer?: string;
    currentTitle?: string;
    noticePeriod?: string;
    expectedSalary?: string;
    currentSalary?: string;
    yearsOfExperience?: number;
  };
  authorization?: {
    statement?: string;
    needsSponsorship?: boolean;
    /** Where the person may work without sponsorship (codes or names). */
    countries?: string[];
    /** Countries they said they may NOT work in without sponsorship. */
    notAuthorized?: string[];
  };
  preferences?: {
    roles?: string[];
    locations?: string[];
    workplace?: string[];
    jobTypes?: string[];
  };
  education?: Array<{
    school: string;
    degree?: string;
    field?: string;
    start?: string;
    end?: string;
    current?: boolean;
    grade?: string;
  }>;
  experience?: Array<{
    company: string;
    title: string;
    location?: string;
    start?: string;
    end?: string;
    current?: boolean;
    highlights?: string[];
  }>;
  skills?: string[];
  /** Tell us more about you: free text in the person's own words. The AI answers form questions from it. */
  about?: string;
  projects?: Array<{ name: string; description?: string; url?: string; tech?: string[] }>;
  /** What recruitment portals of the government ask for. Filled once (asked on the first application), then reused. */
  government?: {
    fatherName?: string;
    motherName?: string;
    /** ISO yyyy-mm-dd */
    dateOfBirth?: string;
    gender?: 'Male' | 'Female' | 'Transgender';
    category?: 'General' | 'OBC' | 'EWS' | 'SC' | 'ST';
    nationality?: string;
    maritalStatus?: string;
    domicileState?: string;
    pwd?: boolean;
    exServiceman?: boolean;
  };
  documents?: { resumeFileId?: string; resumeFileName?: string; photoFileId?: string; signatureFileId?: string };
  settings?: {
    reviewBeforeSubmit?: boolean;
    resumeTailoring?: 'off' | 'honest' | 'aggressive';
    applicationEmailMode?: 'jobpilot-inbox' | 'personal' | 'gmail' | 'outlook';
    notifications?: string;
    smsCodeAutofill?: string;
  };
}

export type OnboardingStatus = 'pending' | 'done' | 'skipped';

export interface Profile {
  userId: string;
  data: ProfileData;
  version: number;
  onboardingStatus: OnboardingStatus;
  completeness: number;
  updatedAt: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge; arrays and scalars in `patch` replace; `null` deletes a key. */
export function mergeProfile<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(isPlainObject(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isPlainObject(v)) out[k] = mergeProfile(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/** 0–100: how ready the profile is to fill a typical application. */
export function computeCompleteness(d: ProfileData): number {
  const checks: boolean[] = [
    !!d.personal?.fullName,
    !!d.personal?.email,
    !!d.personal?.phone,
    !!d.personal?.city,
    !!d.work?.experienceLevel,
    !!d.authorization?.statement,
    (d.preferences?.roles?.length ?? 0) > 0,
    (d.preferences?.locations?.length ?? 0) > 0,
    (d.education?.length ?? 0) > 0,
    (d.experience?.length ?? 0) > 0 || d.work?.experienceLevel === 'Student / fresher',
    (d.skills?.length ?? 0) >= 3,
    !!d.documents?.resumeFileId,
    !!d.personal?.linkedin,
    !!d.work?.noticePeriod,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

/** One-time import of the old flat key/value profile (user_profiles 'default'). */
function fromLegacy(flat: Record<string, string>): ProfileData {
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const fullName = flat.fullName ?? flat.name;
  return {
    personal: {
      fullName,
      firstName: flat.firstName ?? fullName?.split(' ')[0],
      lastName: flat.lastName ?? fullName?.split(' ').slice(1).join(' ') ?? undefined,
      email: flat.email,
      phone: flat.mobile ?? flat.phone,
      phoneVerified: flat.mobileVerified === 'yes' || undefined,
      city: flat.city,
    },
    work: {
      experienceLevel: flat.experienceLevel,
      currentEmployer: flat.currentEmployer,
      noticePeriod: flat.noticePeriod,
      expectedSalary: flat.expectedSalary,
    },
    authorization: {
      statement: flat.workAuthorization,
      needsSponsorship: flat.needsSponsorship ? flat.needsSponsorship === 'yes' : undefined,
    },
    preferences: {
      roles: list(flat.targetRoles),
      locations: list(flat.targetLocations),
      workplace: list(flat.workplace),
      jobTypes: list(flat.jobTypes),
    },
    documents: {
      resumeFileId: flat.resumeFileId,
      resumeFileName: flat.resumeFileName,
      photoFileId: flat.photoFileId,
      signatureFileId: flat.signatureFileId,
    },
    settings: {
      reviewBeforeSubmit: flat.reviewBeforeSubmit ? flat.reviewBeforeSubmit === 'on' : undefined,
      resumeTailoring: flat.resumeTailoring as 'off' | 'honest' | 'aggressive' | undefined,
      applicationEmailMode: flat.applicationEmailMode as NonNullable<ProfileData['settings']>['applicationEmailMode'],
      notifications: flat.notifications,
      smsCodeAutofill: flat.smsCodeAutofill,
    },
  };
}

function strip<T>(v: T): T {
  // Drop undefined / empty containers so stored JSON stays clean.
  if (Array.isArray(v)) return v.map(strip) as T;
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    const s = strip(val);
    if (s === undefined || s === '') continue;
    if (isPlainObject(s) && !Object.keys(s).length) continue;
    out[k] = s;
  }
  return out as T;
}

function rowToProfile(r: {
  user_id: string;
  data: ProfileData;
  version: number;
  onboarding_status: OnboardingStatus;
  completeness: number;
  updated_at: Date;
}): Profile {
  return {
    userId: r.user_id,
    data: r.data ?? {},
    version: r.version,
    onboardingStatus: r.onboarding_status,
    completeness: r.completeness,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export const profileService = {
  /** Get (creating on first access, importing legacy data if any). */
  async get(userId: string): Promise<Profile> {
    const pool = getPgPool();
    const { rows } = await pool.query('SELECT * FROM profiles WHERE user_id = $1', [userId]);
    if (rows[0]) return rowToProfile(rows[0]);

    const legacy = await pool.query(
      `SELECT data FROM user_profiles WHERE user_id = $1 AND profile_name = 'default'`,
      [userId],
    );
    const flat = (legacy.rows[0]?.data ?? {}) as Record<string, string>;
    // Start from the sign-in details, then any legacy profile data on top.
    const account = await pool.query('SELECT email, mobile_number, mobile_verified, display_name FROM users WHERE id::text = $1', [userId]);
    const u = account.rows[0];
    const seed: ProfileData = u
      ? {
          personal: {
            fullName: u.display_name ?? undefined,
            email: u.email ?? undefined,
            phone: u.mobile_number ?? undefined,
            phoneVerified: u.mobile_verified || undefined,
          },
        }
      : {};
    const data = strip(mergeProfile(seed, Object.keys(flat).length ? fromLegacy(flat) : {}));
    const onboarding: OnboardingStatus =
      flat.onboardingStatus === 'done' || flat.onboardingStatus === 'skipped' ? flat.onboardingStatus : 'pending';
    const inserted = await pool.query(
      `INSERT INTO profiles (user_id, data, onboarding_status, completeness)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING *`,
      [userId, JSON.stringify(data), onboarding, computeCompleteness(data)],
    );
    return rowToProfile(inserted.rows[0]);
  },

  /** Deep-merge a partial update and record a version. */
  async patch(userId: string, patch: ProfileData, source = 'user'): Promise<Profile> {
    const current = await this.get(userId);
    const data = strip(mergeProfile(current.data, patch));
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE profiles SET data = $2, completeness = $3, version = version + 1, updated_at = NOW()
          WHERE user_id = $1 RETURNING *`,
        [userId, JSON.stringify(data), computeCompleteness(data)],
      );
      await client.query(
        'INSERT INTO profile_versions (user_id, version, data, source) VALUES ($1, $2, $3, $4)',
        [userId, rows[0].version, JSON.stringify(data), source],
      );
      return rowToProfile(rows[0]);
    });
  },

  async setOnboarding(userId: string, status: OnboardingStatus): Promise<Profile> {
    await this.get(userId);
    const { rows } = await getPgPool().query(
      'UPDATE profiles SET onboarding_status = $2, updated_at = NOW() WHERE user_id = $1 RETURNING *',
      [userId, status],
    );
    return rowToProfile(rows[0]);
  },

  async versions(userId: string, limit = 20) {
    const { rows } = await getPgPool().query(
      'SELECT version, source, created_at FROM profile_versions WHERE user_id = $1 ORDER BY version DESC LIMIT $2',
      [userId, limit],
    );
    return rows;
  },
};

// ─── Answer memory ───────────────────────────────────────────

export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[*:?().\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const questionHash = (q: string) => createHash('sha256').update(normalizeQuestion(q)).digest('hex').slice(0, 32);

export const answerMemory = {
  async list(userId: string) {
    const { rows } = await getPgPool().query(
      `SELECT id, question, answer, source, use_count, last_used_at, updated_at
         FROM answer_memory WHERE user_id = $1 AND source <> 'ai-cache' ORDER BY updated_at DESC`,
      [userId],
    );
    return rows;
  },

  async remember(userId: string, question: string, answer: string, source = 'user') {
    const { rows } = await getPgPool().query(
      `INSERT INTO answer_memory (user_id, question_hash, question, answer, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, question_hash)
       DO UPDATE SET answer = EXCLUDED.answer, source = EXCLUDED.source, updated_at = NOW()
       RETURNING id, question, answer, source, use_count, updated_at`,
      [userId, questionHash(question), question.trim(), answer.trim(), source],
    );
    return rows[0];
  },

  /** Exact (normalized) lookup — used by the form filler before any AI. */
  async recall(userId: string, question: string): Promise<string | null> {
    const { rows } = await getPgPool().query(
      `UPDATE answer_memory SET use_count = use_count + 1, last_used_at = NOW()
        WHERE user_id = $1 AND question_hash = $2 RETURNING answer`,
      [userId, questionHash(question)],
    );
    return rows[0]?.answer ?? null;
  },

  async forget(userId: string, id: number) {
    const { rowCount } = await getPgPool().query('DELETE FROM answer_memory WHERE user_id = $1 AND id = $2', [userId, id]);
    return (rowCount ?? 0) > 0;
  },
};
