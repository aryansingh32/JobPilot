import { getPgPool } from '../db/index.js';

// ============================================================
// FORM SCHEMAS — what an application asks, remembered per posting.
// The first run at a posting records its questions (never anyone's answers);
// after that a job's detail view can say "this asks 7 questions, 2 need you"
// before anything is spent, and answers can be worked out ahead of the browser.
// ============================================================

export interface SchemaField {
  label: string;
  type: string;
  tag: 'input' | 'textarea' | 'select';
  required: boolean;
  options: string[];
  name: string;
  /** Which page of a multi-page application. */
  page?: number;
}

/**
 * Query parameters that say WHICH posting it is (a company careers page shows many jobs at one path).
 * Everything else — utm_*, source, ref, session ids — is noise and dropped.
 */
const IDENTITY_PARAMS = ['gh_jid', 'ashby_jid', 'jid', 'jobid', 'job_id', 'job', 'jobref', 'jr_id', 'reqid', 'req_id', 'requisitionid', 'requisition_id', 'career_job_req_id', 'jvi', 'vacancyid', 'positionid', 'opening', 'id'];

/** host + path (+ the parameters that pick the posting), lower-cased: the identity of a posting across links. */
export function postingKey(url: string): string | null {
  const key = schemaKey(url);
  if (!key) return null;
  try {
    const u = new URL(url);
    const keep = [...u.searchParams.entries()]
      .filter(([k, v]) => v && IDENTITY_PARAMS.includes(k.toLowerCase()))
      .map(([k, v]) => `${k.toLowerCase()}=${v.toLowerCase()}`)
      .sort();
    return keep.length ? `${key}?${keep.join('&')}` : key;
  } catch {
    return key;
  }
}

/** host + path with the noise removed: query, hash, trailing /apply, locale prefixes on Workday. */
export function schemaKey(url: string): string | null {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/+$/, '').replace(/\/(apply|application|applyManually|autofillWithResume)$/i, '');
    // Workday: /en-US/<site>/job/<loc>/<title>_<REQ> — the requisition id is the identity.
    if (/myworkdayjobs\.com$/i.test(u.hostname)) path = path.replace(/^\/[a-z]{2}-[A-Z]{2}\//, '/');
    return `${u.hostname.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return null;
  }
}

const atsOf = (host: string): string | null =>
  /greenhouse\.io/.test(host) ? 'greenhouse' : /lever\.co/.test(host) ? 'lever' : /ashbyhq\.com/.test(host) ? 'ashby'
  : /myworkdayjobs|workday/.test(host) ? 'workday' : /smartrecruiters/.test(host) ? 'smartrecruiters' : /workable/.test(host) ? 'workable'
  : /recruitee/.test(host) ? 'recruitee' : /icims/.test(host) ? 'icims' : /oraclecloud/.test(host) ? 'oracle' : /successfactors/.test(host) ? 'successfactors' : null;

export const formSchemas = {
  /**
   * Save what was seen. A thinner read than the one on file (a half-loaded wizard) never replaces it, and a
   * complete one always does.
   */
  async record(url: string, fields: SchemaField[], opts: { pages?: number; complete?: boolean } = {}): Promise<void> {
    const key = postingKey(url);
    if (!key || !fields.length) return;
    const trimmed = fields.map((f) => ({ ...f, options: f.options.slice(0, 40), label: f.label.slice(0, 300) }));
    const host = new URL(url).hostname.toLowerCase();
    await getPgPool().query(
      `INSERT INTO form_schemas (schema_key, ats, host, url_sample, fields, pages, complete)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (schema_key) DO UPDATE SET
         fields     = CASE WHEN EXCLUDED.complete OR jsonb_array_length(EXCLUDED.fields) >= jsonb_array_length(form_schemas.fields) THEN EXCLUDED.fields ELSE form_schemas.fields END,
         pages      = GREATEST(form_schemas.pages, EXCLUDED.pages),
         complete   = form_schemas.complete OR EXCLUDED.complete,
         url_sample = EXCLUDED.url_sample,
         seen_count = form_schemas.seen_count + 1,
         last_seen  = NOW()`,
      [key, atsOf(host), host, url.slice(0, 500), JSON.stringify(trimmed), opts.pages ?? 1, opts.complete ?? false],
    );
  },

  async get(url: string): Promise<{ fields: SchemaField[]; pages: number; complete: boolean; seenCount: number; lastSeen: Date } | null> {
    const key = postingKey(url);
    if (!key) return null;
    const { rows } = await getPgPool().query('SELECT fields, pages, complete, seen_count, last_seen FROM form_schemas WHERE schema_key = $1', [key]);
    const r = rows[0];
    return r ? { fields: r.fields as SchemaField[], pages: r.pages, complete: r.complete, seenCount: r.seen_count, lastSeen: r.last_seen } : null;
  },

  /** A posting that is gone: forget what it asked, so nobody is promised a form that no longer exists. */
  async forget(url: string): Promise<void> {
    const key = postingKey(url);
    if (key) await getPgPool().query('DELETE FROM form_schemas WHERE schema_key = $1', [key]);
  },
};
