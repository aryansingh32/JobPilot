import { randomBytes } from 'crypto';
import { getPgPool, getRedisClient, CacheKeys } from '../db/index.js';
import { getBool, getString } from '../config/settings.js';
import { createLogger } from '../logger/index.js';
import { sendEmail } from '../email/index.js';
import { notificationsService } from '../notifications/index.js';
import { applicationsService } from '../applications/index.js';

// ============================================================
// INBOX — every user gets a private address for applications. Mail arrives
// via the inbound webhook (Cloudflare Email Routing worker / SES → POST).
// Rules (no AI): pull out one-time codes, categorise, match the email to the
// user's application, and — if that application is paused waiting for a
// code — resume it automatically.
// ============================================================

const logger = createLogger('inbox');

export type EmailCategory = 'code' | 'confirmation' | 'reply' | 'other';
export type EmailIntent = 'interview' | 'assessment' | 'offer' | 'rejection';

/** What an employer's reply means — strongest signal first (an offer email often mentions the interviews). */
export function classifyIntent(subject: string, body: string): EmailIntent | null {
  const s = `${subject}\n${body.slice(0, 3000)}`.toLowerCase();
  if (/offer letter|pleased to (extend|offer)|extend (you )?an offer|(job|employment) offer|offer of employment/.test(s)) return 'offer';
  if (
    /unfortunately|not (to )?(move|moving) forward|decided (to|not to) (move|proceed|pursue)|other candidates|not been selected|were not selected|position has (been|now been) filled|regret to inform|no longer (being )?considered/.test(s)
  ) {
    return 'rejection';
  }
  if (/assessment|coding (challenge|test|exercise)|take[- ]home|hackerrank|codility|codesignal|online test|technical (test|exercise)/.test(s)) {
    return 'assessment';
  }
  if (/interview|phone screen|schedule (a|some) (time|call|chat)|your availability|calendly\.com|book a (time|slot)|meet (with )?the (team|hiring)|next steps/.test(s)) {
    return 'interview';
  }
  return null;
}

/** Outcome an intent moves the application to; never downgrades an offer or reopens a rejection. */
const OUTCOME_OF: Record<EmailIntent, string> = { interview: 'interview', assessment: 'assessment', offer: 'offer', rejection: 'rejected' };
const OUTCOME_RANK: Record<string, number> = { confirmed: 0, assessment: 1, interview: 2, rejected: 3, offer: 4 };

const INTENT_TITLE: Record<EmailIntent, (from: string) => string> = {
  interview: (from) => `Interview request from ${from}`,
  assessment: (from) => `${from} sent an assessment`,
  offer: (from) => `Offer from ${from}`,
  rejection: (from) => `Update from ${from}`,
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 24) || 'me';

/** Find a one-time code near words like OTP / code / verification. */
export function extractCode(text: string): string | null {
  // Greenhouse: "Copy and paste this code into the security code field on your application: Zk7aQ2Lm"
  const pasted = text.match(/paste this code[^:\n]{0,100}:\s*([A-Za-z0-9]{6,10})\b/i);
  if (pasted) return pasted[1];
  const near = text.match(
    /(?:otp|one[- ]time|verification|security|confirmation|login|access)\s*(?:code|passcode|password|pin)?(?:\s+is)?[^0-9A-Za-z]{0,40}([0-9]{4,8}|(?=[A-Z]*\d)[A-Z0-9]{6,8})\b/i,
  );
  if (near) return near[1];
  const codeIs = text.match(/\bcode(?:\s+is)?[:\s]+([0-9]{4,8})\b/i);
  if (codeIs) return codeIs[1];
  // "Use this verification code to continue your application: 346369" — words in between:
  // a 6–8 digit number standing alone within a sentence or two after the keyword.
  const later = text.match(/(?:otp|one[- ]time|verification|security|passcode|\bcode\b)[^\n]{0,120}?(?<![\d.,/-])\b(\d{6,8})\b(?![.,/-]?\d)/i);
  return later ? later[1] : null;
}

/**
 * The account-verification link in an email ("Verify your email", "Activate
 * your account"): the first link near those words, else one whose URL says so.
 */
export function extractVerifyLink(text: string): string | null {
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => ({ url: m[0].replace(/[.,;]+$/, ''), at: m.index ?? 0 }));
  if (!urls.length) return null;
  const words = /verif|confirm|activat|validate/gi;
  for (const u of urls) {
    const before = text.slice(Math.max(0, u.at - 160), u.at);
    if (words.test(before)) return u.url;
    words.lastIndex = 0;
  }
  return urls.find((u) => /verif|confirm|activat|validat|token=|registration/i.test(u.url))?.url ?? null;
}

/** Applicant systems that send codes and links for employers (their mail rarely names the company). */
const ATS_SENDERS = /workday|myworkday|successfactors|sapsf|oracle|taleo|icims|greenhouse|lever|ashby|smartrecruiters|zoho|freshteam|keka|darwinbox|jobvite|recruitee|workable|eightfold|phenom/i;

export function categorize(subject: string, body: string, code: string | null, link: string | null = null): EmailCategory {
  const s = `${subject}\n${body.slice(0, 2000)}`.toLowerCase();
  if (code && /otp|code|verif|one[- ]time|passcode/.test(s)) return 'code';
  // "Verify your candidate account" with a link instead of a number: handled like a code (shown as one, delivered to the waiting run).
  if (link && /verif|activat|confirm your (email|account)|candidate account/.test(s)) return 'code';
  if (/thank you for (applying|your application)|application (was )?received|we('ve| have) received your application|application submitted|confirm(ed|ation)/.test(s)) {
    return 'confirmation';
  }
  if (/interview|next steps|schedule|availability|would love to|reach out|regarding your application|unfortunately/.test(s)) {
    return 'reply';
  }
  return 'other';
}

export interface InboundMail {
  to: string;
  fromAddress: string;
  fromName?: string;
  subject?: string;
  text?: string;
}

async function forwardReply(userId: string, mail: InboundMail, subject: string, text: string): Promise<void> {
  const { rows } = await getPgPool().query('SELECT email FROM users WHERE id = $1', [userId]);
  const own: string | undefined = rows[0]?.email;
  if (!own || own.toLowerCase() === mail.to.toLowerCase()) return;
  const from = mail.fromName ? `${mail.fromName} <${mail.fromAddress}>` : mail.fromAddress;
  await sendEmail(own, `Fwd: ${subject || 'Reply to your application'}`,
    `${from} wrote to your jobpilot inbox (${mail.to}). Reply to them at ${mail.fromAddress}.\n\n${text}`);
}

/**
 * The address an application is made with. The private inbox once it's live
 * (codes and links then handle themselves), else the user's own email — a
 * connected Gmail is read for codes and replies to that address.
 */
export async function applicationEmail(userId: string, personal: { email?: string; firstName?: string; fullName?: string } | undefined,
  mode: string | undefined): Promise<{ email: string | null; via: 'inbox' | 'gmail' | 'personal' }> {
  if (mode === 'jobpilot-inbox' && (await getBool('features.inbox')) && (await getBool('inbox.live'))) {
    return { email: await inboxService.ensureAddress(userId, personal?.firstName ?? personal?.fullName), via: 'inbox' };
  }
  if (mode === 'gmail') {
    const { rows } = await getPgPool().query(
      `SELECT address FROM mail_connections WHERE user_id = $1 AND provider = 'gmail' AND status = 'active'`, [userId]);
    if (rows[0]) return { email: rows[0].address, via: 'gmail' };
  }
  // The application email is the connected Gmail address even if the mode was never switched: read it.
  if (personal?.email) {
    const { rows } = await getPgPool().query(
      `SELECT 1 FROM mail_connections WHERE user_id = $1 AND provider = 'gmail' AND status = 'active' AND lower(address) = lower($2)`,
      [userId, personal.email]);
    if (rows[0]) return { email: personal.email, via: 'gmail' };
  }
  return { email: personal?.email ?? null, via: 'personal' };
}

/** Hand a mailed code / link to the application once it waits for that kind of input (up to ~30 s). */
async function deliverToWaiting(userId: string, applicationId: string, code: string | null, link: string | null, emailId: string): Promise<void> {
  const pool = getPgPool();
  for (let i = 0; i < 15; i++) {
    const { rows } = await pool.query('SELECT status, exec_job_id FROM applications WHERE id = $1', [applicationId]);
    const app = rows[0];
    if (!app || !['needs_input', 'running', 'queued'].includes(app.status)) return;
    if (app.status === 'needs_input' && app.exec_job_id) {
      const redis = await getRedisClient();
      const runtime = await redis.get(CacheKeys.jobRuntime(app.exec_job_id));
      const waitingFor = runtime ? (JSON.parse(runtime) as { lastInputType?: string }).lastInputType : undefined;
      // A code the site texted can't arrive by email: leave it for the user.
      const pendingRaw = await redis.get(`captcha:pending:${app.exec_job_id}`);
      if (code && pendingRaw && (JSON.parse(pendingRaw) as { payload?: { channel?: string } }).payload?.channel === 'sms') return;
      const fits = code ? !waitingFor || ['otp', 'mfa', 'loginVerification'].includes(waitingFor) : waitingFor === 'emailLink';
      if (!fits) return; // waiting on something else (a question, the review)
      // Through the apply engine, so a parked application continues too.
      const { respondToApplication } = await import('../applications/apply.js');
      if (await respondToApplication(userId, applicationId, (code ?? link)!)) {
        await applicationsService.event(applicationId, code ? 'code_autofilled' : 'link_opened', { emailId });
        logger.info(code ? 'inbox:code-autofilled' : 'inbox:link-autofilled', { applicationId });
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export const inboxService = {
  async ensureAddress(userId: string, displayName?: string | null): Promise<string> {
    const pool = getPgPool();
    const existing = await pool.query('SELECT address FROM inbox_addresses WHERE user_id = $1', [userId]);
    if (existing.rows[0]) return existing.rows[0].address;
    const domain = await getString('inbox.domain');
    for (let i = 0; i < 5; i++) {
      const address = `${slug(displayName ?? 'me')}.${randomBytes(3).toString('hex')}@${domain}`;
      const res = await pool.query(
        `INSERT INTO inbox_addresses (user_id, address) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING address`,
        [userId, address],
      );
      if (res.rows[0]) return res.rows[0].address;
    }
    throw new Error('Could not allocate an inbox address');
  },

  async getAddress(userId: string): Promise<string | null> {
    const { rows } = await getPgPool().query('SELECT address FROM inbox_addresses WHERE user_id = $1', [userId]);
    return rows[0]?.address ?? null;
  },

  /** Inbound mail. Returns null when the address isn't ours (silently dropped). */
  async ingest(mail: InboundMail) {
    if (!(await getBool('features.inbox'))) return null;
    const to = mail.to.trim().toLowerCase();
    const owner = await getPgPool().query('SELECT user_id FROM inbox_addresses WHERE lower(address) = $1', [to]);
    const userId: string | undefined = owner.rows[0]?.user_id;
    if (!userId) {
      logger.warn('inbox:unknown-recipient', { to });
      return null;
    }
    return inboxService.ingestForUser(userId, mail);
  },

  /**
   * One email for a user: store it, match it to an application, fill a code
   * or open a verification link the application waits for, move the outcome.
   * `strict` (a connected personal mailbox): keep only mail that belongs to
   * one of the user's applications — everything else is dropped unread.
   */
  async ingestForUser(userId: string, mail: InboundMail, opts: { source?: 'inbox' | 'gmail'; externalId?: string; strict?: boolean; /** sender domains of a site a run is waiting on (a gov portal's own code mail) */ allowFrom?: string[]; /** when the mail really arrived (Gmail's date), not when we fetched it */ receivedAt?: Date } = {}) {
    const pool = getPgPool();
    const to = mail.to.trim().toLowerCase();
    const subject = (mail.subject ?? '').slice(0, 500);
    const text = (mail.text ?? '').slice(0, 50_000);
    const code = extractCode(`${subject}\n${text}`);
    const link = code ? null : extractVerifyLink(text);
    const received = /received your application|thank you for (applying|your application)|application (was )?(received|submitted)|we('ve| have) received your/i.test(subject);
    const intent = code || received ? null : classifyIntent(subject, text);
    const category = intent ? 'reply' : categorize(subject, text, code, link);

    // Match: the most recent open application whose company appears in the
    // sender name/domain or subject; else the most recent paused one for codes.
    const sender = `${mail.fromName ?? ''} ${mail.fromAddress}`.toLowerCase();
    const apps = await pool.query(
      `SELECT id, company, status, exec_job_id FROM applications
        WHERE user_id = $1 AND updated_at > NOW() - INTERVAL '30 days'
        ORDER BY updated_at DESC LIMIT 50`,
      [userId],
    );
    let match: { id: string; status: string; exec_job_id: string | null } | undefined;
    let matchMethod: string | null = null;
    for (const a of apps.rows) {
      const company = (a.company ?? '').toLowerCase().trim();
      if (company.length >= 3 && (sender.includes(company.replace(/\s+/g, '')) || sender.includes(company) || subject.toLowerCase().includes(company))) {
        match = a;
        matchMethod = 'company';
        break;
      }
    }
    // A code or verification link from an applicant system goes to the application waiting for one.
    const fromAts = ATS_SENDERS.test(`${sender} ${subject}`) || !!opts.allowFrom?.some((d) => sender.includes(d.toLowerCase()));
    if (!match && (category === 'code' || link) && (!opts.strict || fromAts)) {
      // Waiting for it, or about to (sites mail while the run is still on their page).
      match = apps.rows.find((a) => a.status === 'needs_input') ?? apps.rows.find((a) => a.status === 'running');
      if (match) matchMethod = code ? 'awaiting_code' : 'awaiting_link';
    }
    // A personal mailbox: nothing that isn't about an application is kept (bank OTPs, newsletters…).
    if (opts.strict && !match) return null;

    const { rows } = await pool.query(
      `INSERT INTO emails (user_id, to_address, from_name, from_address, subject, snippet, body_text, category,
                           extracted_code, application_id, match_method, intent, source, external_id, extracted_link, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($16, NOW()))
       ON CONFLICT (user_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING *`,
      [userId, to, mail.fromName ?? null, mail.fromAddress, subject, text.replace(/\s+/g, ' ').slice(0, 280), text,
        category, code, match?.id ?? null, matchMethod, intent, opts.source ?? 'inbox', opts.externalId ?? null, link, opts.receivedAt ?? null],
    );
    const email = rows[0];
    if (!email) return null; // seen before (Gmail re-sync)

    // A paused application waiting for a code (or a verification link) gets it automatically.
    // Sites can mail faster than the run pauses: a running one is given a few seconds to get there.
    if ((code || link) && match && ['needs_input', 'running', 'queued'].includes(match.status)) {
      const fill = () => deliverToWaiting(userId, match!.id, code, link, email.id);
      if (match.status === 'needs_input') await fill();
      else void fill();
    }
    // The employer's answer moves the application along (the tracker's pipeline).
    const outcome = intent ? OUTCOME_OF[intent] : category === 'confirmation' ? 'confirmed' : null;
    if (match && outcome) {
      const { rowCount } = await pool.query(
        `UPDATE applications SET outcome = $2, updated_at = NOW()
          WHERE id = $1 AND (outcome IS NULL OR $3 > CASE outcome ${Object.entries(OUTCOME_RANK).map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(' ')} END)`,
        [match.id, outcome, OUTCOME_RANK[outcome]],
      );
      if (rowCount) await applicationsService.event(match.id, `employer_${outcome}`, { emailId: email.id, subject });
    }

    // Employers writing to the private inbox also reach the user's own email.
    if (category === 'reply' && (opts.source ?? 'inbox') === 'inbox' && (await getBool('inbox.forward_replies'))) {
      void forwardReply(userId, mail, subject, text).catch((err) => logger.warn('inbox:forward-failed', { error: (err as Error).message }));
    }

    // Employers writing back are worth a push; codes are handled above.
    if (category === 'reply' || category === 'confirmation') {
      const from = mail.fromName || mail.fromAddress;
      await notificationsService.notify(userId, {
        kind: 'inbox.email',
        title: intent ? INTENT_TITLE[intent](from) : category === 'reply' ? `New reply from ${from}` : 'Application confirmed by email',
        body: subject || email.snippet,
        data: { emailId: email.id, applicationId: match?.id, intent },
      });
    }
    return email;
  },

  async list(userId: string, category?: string, limit = 50) {
    const { rows } = await getPgPool().query(
      `SELECT e.id, e.from_name, e.from_address, e.subject, e.snippet, e.category, e.intent, e.extracted_code, e.read,
              e.received_at, e.application_id, a.title AS application_title
         FROM emails e LEFT JOIN applications a ON a.id = e.application_id
        WHERE e.user_id = $1 AND ($2::text IS NULL OR e.category = $2)
        ORDER BY e.received_at DESC LIMIT $3`,
      [userId, category ?? null, Math.min(limit, 200)],
    );
    return rows;
  },

  async get(userId: string, id: string) {
    const { rows } = await getPgPool().query('SELECT * FROM emails WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows[0] ?? null;
  },

  async markRead(userId: string, id: string, read = true) {
    const { rowCount } = await getPgPool().query('UPDATE emails SET read = $3 WHERE id = $1 AND user_id = $2', [id, userId, read]);
    return (rowCount ?? 0) > 0;
  },

  async unreadCount(userId: string): Promise<number> {
    const { rows } = await getPgPool().query('SELECT COUNT(*)::int AS n FROM emails WHERE user_id = $1 AND NOT read', [userId]);
    return rows[0].n;
  },
};
