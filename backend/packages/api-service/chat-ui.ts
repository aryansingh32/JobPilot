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
  | { type: 'jobs'; source?: 'matches' | 'search' | 'government'; query?: string; location?: string; country?: string; workplace?: string; experienceLevel?: 'fresher' | 'any'; limit?: number; title?: string }
  | { type: 'ask'; kind: 'otp' | 'number' | 'text' | 'choice' | 'confirm'; prompt: string; options?: string[]; length?: number }
  | { type: 'island'; tone?: 'info' | 'success' | 'warn' | 'error'; title: string; body?: string; view?: 'tasks' | 'inbox' | 'jobs' | 'autoapply'; label?: string }
  | { type: 'open'; view: 'tasks' | 'inbox' | 'jobs' | 'autoapply'; label?: string }
  | { type: 'applications' };

export type UiCard =
  | { type: 'jobs'; title: string; jobs: ReturnType<typeof toListing>[]; empty?: string; hasMore?: boolean; broadened?: boolean; search?: { q?: string; location?: string; country?: string; workplace?: string; includeRemote?: boolean; experienceLevel?: 'fresher' } }
  | { type: 'ask'; kind: 'otp' | 'number' | 'text' | 'choice' | 'confirm'; prompt: string; options?: string[]; length?: number }
  | { type: 'island'; tone: 'info' | 'success' | 'warn' | 'error'; title: string; body?: string; view?: string; label?: string }
  | { type: 'open'; view: string; label: string }
  | { type: 'applications'; items: { id: string; title: string; company: string | null; status: string; detail: string | null; updatedAt: string }[] };

const VIEWS = ['tasks', 'inbox', 'jobs', 'autoapply'] as const;
const VIEW_LABEL: Record<string, string> = { tasks: 'Open Applications', inbox: 'Open Inbox', jobs: 'Browse jobs', autoapply: 'Open Auto Apply' };
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const SEARCH_NOISE = new Set(['a', 'an', 'and', 'any', 'both', 'can', 'find', 'for', 'fresh', 'fresher', 'freshers', 'from', 'gov', 'government', 'have', 'india', 'indian', 'job', 'jobs', 'level', 'location', 'me', 'my', 'of', 'please', 'public', 'remote', 'role', 'roles', 'search', 'tech', 'technology', 'the', 'with', 'work', 'zero', 'experience', 'exp', 'entry', 'no']);

function searchTerms(query: string): string | undefined {
  const rawWords = query.toLowerCase().match(/[a-z0-9+#.]+/g) ?? [];
  const words = rawWords.flatMap((word) => ['tech', 'technology'].includes(word) ? ['software', 'developer', 'engineer'] : [word])
    .filter((word) => word.length > 1 && !SEARCH_NOISE.has(word));
  return [...new Set(words)].slice(0, 6).join(' ') || undefined;
}

async function findChatJobs(args: {
  query: string;
  context: string;
  location?: string;
  country?: string;
  workplace?: string;
  employmentType?: string;
  experienceLevel?: 'fresher' | 'any';
  limit: number;
}) {
  const lower = `${args.context} ${args.query} ${args.location ?? ''} ${args.country ?? ''} ${args.workplace ?? ''}`.toLowerCase();
  const removeIndia = /\b(?:not|without|anywhere|worldwide|global)\s+(?:india(?:n)?(?: specific)?|location|country filter)\b/i.test(lower);
  const country = !removeIndia && (/^IN$/i.test(args.country ?? '') || /\bindia\b/i.test(args.country ?? '') || /\bindia\b/.test(lower)) ? 'IN' : undefined;
  const removeRemote = /\bnot remote\b|\bwithout remote\b/i.test(lower);
  const remote = !removeRemote && (/\bremote\b/i.test(`${args.query} ${args.context} ${args.workplace ?? ''}`) || /remote/i.test(args.workplace ?? ''));
  const removeFresher = /\b(?:any|all) experience levels\b|\bremove (?:the )?experience filter\b|\bwithout (?:the )?experience filter\b/i.test(lower);
  const fresher = !removeFresher && (args.experienceLevel === 'fresher' || /\b(fresher|freshers|entry.level|zero experience|no experience|0 years?)\b/i.test(lower));
  const query = searchTerms(args.query);
  const branches: Array<{ country?: string; workplace?: string }> = country && remote
    ? [{ country }, { workplace: 'Remote' }]
    : country ? [{ country }]
      : remote ? [{ workplace: 'Remote' }]
        : args.location ? [{ country: undefined }] : [{}];
  const unique = new Map<string, ReturnType<typeof toListing>>();
  let broadened = false;
  let hasMore = false;
  const run = async (withQuery: boolean, withExperience: boolean, currentBranches = branches) => {
    const perBranchLimit = Math.max(2, Math.ceil(args.limit / currentBranches.length));
    const results = await Promise.all(currentBranches.map((branch) => searchJobs({
        text: withQuery ? query : undefined,
        country: branch.country,
        workplace: branch.workplace,
        location: country || remote ? undefined : args.location || undefined,
        employmentType: args.employmentType,
        experienceLevel: withExperience && fresher ? 'fresher' : undefined,
        pageSize: perBranchLimit,
      })));
    for (const result of results) {
      for (const job of result.jobs) unique.set(job.id, toListing(job));
      hasMore ||= result.hasMore;
    }
  };

  await run(true, true);
  if (unique.size < args.limit) { broadened = true; await run(false, true); }
  if (unique.size < args.limit) { broadened = true; await run(true, false); }
  if (unique.size < args.limit) { broadened = true; await run(false, false); }
  // If the chosen role and region are empty, show nearby feed options instead of a dead-end card.
  if (unique.size < args.limit && (country || remote || fresher)) { broadened = true; await run(false, false, [{}]); }
  const jobs = [...unique.values()].slice(0, args.limit);
  const labels = [fresher ? 'fresher-friendly' : '', country ? 'India' : '', remote ? 'remote' : ''].filter(Boolean);
  return {
    jobs,
    title: broadened ? 'More roles to explore' : labels.length ? `${labels.join(' · ')} roles` : 'Open roles',
    hasMore: hasMore || unique.size > args.limit,
    broadened,
    search: {
      q: query,
      location: country || remote ? undefined : args.location || undefined,
      country,
      includeRemote: country && remote ? true : undefined,
      workplace: remote && !country ? 'Remote' : undefined,
      experienceLevel: fresher ? 'fresher' as const : undefined,
    },
    empty: `I couldn't find open roles for those filters in the feed right now. You can browse all jobs or loosen a filter and try again.`,
  };
}

/** Directives the model wrote → cards for this user. At most 4, in order. */
export async function resolveUi(
  userId: string,
  raw: unknown,
  context: { message?: string; history?: Array<{ role?: string; content?: string }> } = {},
): Promise<UiCard[]> {
  if (!Array.isArray(raw)) return [];
  const cards: UiCard[] = [];
  // Look at a few more than we show: a malformed directive must not use up a slot.
  for (const d of raw.slice(0, 12) as Record<string, unknown>[]) {
    if (cards.length >= 4) break;
    // One coherent result set per reply; duplicate model directives were creating
    // repeated empty job cards in the same conversation turn.
    if (d?.type === 'jobs' && cards.some((card) => card.type === 'jobs')) continue;
    try {
      switch (d?.type) {
        case 'jobs': {
          const limit = Math.min(Math.max(Number(d.limit) || 4, 1), 6);
          const source = d.source === 'search' || d.source === 'government' ? d.source : 'matches';
          let jobs: ReturnType<typeof toListing>[] = [];
          let title = '';
          let empty: string | undefined;
          let hasMore: boolean | undefined;
          let broadened: boolean | undefined;
          let search: Extract<UiCard, { type: 'jobs' }>['search'];
          const userContext = (context.history ?? []).filter((item) => item.role === 'user').map((item) => item.content ?? '').join(' ');
          const contextualSearch = /\b(job|jobs|role|roles|opening|position|career|remote|location|fresher|experience|india)\b/i.test(`${userContext} ${context.message ?? ''}`);
          if (source === 'matches' && !clip(d.query, 80) && !contextualSearch) {
            const profile = await profileService.get(userId);
            jobs = (await recommendJobs(userId, profile.data, limit)).map((r) => toListing(r.job, r.score, r.reasons, r.matchedSkills));
          } else {
            const query = clip(d.query, 120) || context.message || '';
            const found = await findChatJobs({
              query,
              context: source === 'government' ? context.message ?? '' : `${userContext} ${context.message ?? ''}`,
              location: clip(d.location, 60) || undefined,
              country: source === 'government' ? 'IN' : clip(d.country, 8) || undefined,
              workplace: source === 'government' ? undefined : clip(d.workplace, 20) || undefined,
              employmentType: source === 'government' ? 'Government' : undefined,
              experienceLevel: source === 'government' ? 'any' : d.experienceLevel === 'fresher' ? 'fresher' : 'any',
              limit,
            });
            jobs = found.jobs;
            title = clip(d.title, 80) || found.title;
            empty = found.empty;
            hasMore = found.hasMore;
            broadened = found.broadened;
            search = found.search;
          }
          cards.push({
            type: 'jobs',
            title: title || clip(d.title, 80) || (source === 'government' ? 'Government openings' : 'Roles for you'),
            jobs,
            empty: jobs.length ? undefined : source === 'government'
              ? 'No government notices are open right now — I check the notice boards every hour and will tell you when one appears.'
              : empty ?? 'I couldn’t find roles that fit your saved profile yet. Browse all jobs or add your preferred roles and skills to your profile.',
            hasMore,
            broadened,
            search,
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
