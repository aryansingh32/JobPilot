import { profileService } from '../shared/profile/index.js';
import { recommendJobs, searchJobs, toListing } from '../shared/jobs/matcher.js';
import { applicationsService } from '../shared/applications/index.js';
import { createLogger } from '../shared/logger/index.js';

// ============================================================
// RICH REPLIES — the assistant can ask for UI next to its words:
// real job cards, a one-tap question (code, number, choice), an
// island notice, a shortcut to a screen, live application status.
// The model only names *what* to show; this resolves it against the
// user's own data and drops anything malformed.
// ============================================================

const logger = createLogger('chat-ui');

export type UiDirective =
  | { type: 'jobs'; source?: 'matches' | 'search' | 'government'; query?: string; location?: string; limit?: number; title?: string }
  | { type: 'ask'; kind: 'otp' | 'number' | 'text' | 'choice' | 'confirm'; prompt: string; options?: string[]; length?: number }
  | { type: 'island'; tone?: 'info' | 'success' | 'warn' | 'error'; title: string; body?: string; view?: 'tasks' | 'inbox' | 'jobs' | 'autoapply'; label?: string }
  | { type: 'open'; view: 'tasks' | 'inbox' | 'jobs' | 'autoapply'; label?: string }
  | { type: 'applications' };

export type UiCard =
  | { type: 'jobs'; title: string; jobs: ReturnType<typeof toListing>[]; empty?: string }
  | { type: 'ask'; kind: 'otp' | 'number' | 'text' | 'choice' | 'confirm'; prompt: string; options?: string[]; length?: number }
  | { type: 'island'; tone: 'info' | 'success' | 'warn' | 'error'; title: string; body?: string; view?: string; label?: string }
  | { type: 'open'; view: string; label: string }
  | { type: 'applications'; items: { id: string; title: string; company: string | null; status: string; detail: string | null; updatedAt: string }[] };

const VIEWS = ['tasks', 'inbox', 'jobs', 'autoapply'] as const;
const VIEW_LABEL: Record<string, string> = { tasks: 'Open Applications', inbox: 'Open Inbox', jobs: 'Browse jobs', autoapply: 'Open Auto Apply' };
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

/** Directives the model wrote → cards for this user. At most 4, in order. */
export async function resolveUi(userId: string, raw: unknown): Promise<UiCard[]> {
  if (!Array.isArray(raw)) return [];
  const cards: UiCard[] = [];
  for (const d of raw.slice(0, 4) as Record<string, unknown>[]) {
    try {
      switch (d?.type) {
        case 'jobs': {
          const limit = Math.min(Math.max(Number(d.limit) || 4, 1), 6);
          const source = d.source === 'search' || d.source === 'government' ? d.source : 'matches';
          let jobs: ReturnType<typeof toListing>[] = [];
          if (source === 'matches' && !clip(d.query, 80)) {
            const profile = await profileService.get(userId);
            jobs = (await recommendJobs(userId, profile.data, limit)).map((r) => toListing(r.job, r.score, r.reasons, r.matchedSkills));
          } else {
            const res = await searchJobs({
              text: clip(d.query, 80) || undefined,
              location: clip(d.location, 60) || undefined,
              employmentType: source === 'government' ? 'Government' : undefined,
              country: source === 'government' ? 'IN' : undefined,
              pageSize: limit,
            });
            jobs = res.jobs.map((j) => toListing(j));
          }
          cards.push({
            type: 'jobs',
            title: clip(d.title, 80) || (source === 'government' ? 'Government openings' : 'Roles for you'),
            jobs,
            empty: jobs.length ? undefined : source === 'government'
              ? 'No government notices are open right now — I check the notice boards every hour and will tell you when one appears.'
              : 'Nothing matched that yet.',
          });
          break;
        }
        case 'ask': {
          const kind = (['otp', 'number', 'text', 'choice', 'confirm'] as const).find((k) => k === d.kind);
          const prompt = clip(d.prompt, 240);
          if (!kind || !prompt) break;
          const options = Array.isArray(d.options) ? d.options.map((o) => clip(o, 60)).filter(Boolean).slice(0, 8) : undefined;
          if (kind === 'choice' && !options?.length) break;
          const length = Number(d.length);
          cards.push({ type: 'ask', kind, prompt, options, length: length >= 4 && length <= 8 ? length : undefined });
          break;
        }
        case 'island': {
          const title = clip(d.title, 90);
          if (!title) break;
          const tone = (['info', 'success', 'warn', 'error'] as const).find((t) => t === d.tone) ?? 'info';
          const view = VIEWS.find((v) => v === d.view);
          cards.push({ type: 'island', tone, title, body: clip(d.body, 200) || undefined, view, label: clip(d.label, 24) || (view ? VIEW_LABEL[view] : undefined) });
          break;
        }
        case 'open': {
          const view = VIEWS.find((v) => v === d.view);
          if (view) cards.push({ type: 'open', view, label: clip(d.label, 30) || VIEW_LABEL[view] });
          break;
        }
        case 'applications': {
          const rows = (await applicationsService.list(userId, 'all', 5, 0)) as Record<string, unknown>[];
          cards.push({
            type: 'applications',
            items: rows.map((a) => ({
              id: String(a.id), title: String(a.title ?? ''), company: (a.company as string) ?? null,
              status: String(a.status), detail: (a.status_detail as string) ?? null, updatedAt: String(a.updated_at ?? ''),
            })),
          });
          break;
        }
      }
    } catch (err) {
      logger.warn('ui:resolve-failed', { type: String(d?.type), error: (err as Error).message });
    }
  }
  return cards;
}
