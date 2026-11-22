import { getRedisClient, CacheKeys } from '../shared/db/index.js';
import { complete, completeJSON, LLMBlockedError } from '../shared/llm/gateway.js';
import { memoryService } from './user-memory.service.js';
import type { ConversationState, ExecuteJob, JobRuntimeState, SiteWorkflow } from '../shared/types/index.js';
import { DuplicateTaskError, enqueueJob, getJobPosition } from '../shared/queue/index.js';
import { randomUUID } from 'crypto';
import { fileStorageService } from './file-storage.service.js';
import { siteWorkflowService } from './site-workflow.service.js';
import { FORMKARO_SYSTEM_PROMPT } from './prompts/formkaro-chat.js';
import { createLogger } from '../shared/logger/index.js';
import { resolveUi, type UiCard } from './chat-ui.js';
import { applicationsService, LimitError } from '../shared/applications/index.js';
import { SENSITIVE_INPUT, fitsSensitiveInput } from '../execution-service/gov-forms.js';
import { ApplyError, resumeExecJob, startApplication } from '../shared/applications/apply.js';
import { InsufficientCreditsError } from '../shared/credits/index.js';
import { getJob, toListing } from '../shared/jobs/matcher.js';

// ============================================================
// CHAT ORCHESTRATOR
// Brain of the chatbot. Uses an LLM (OpenRouter, Local, etc.)
// to understand intent, manage state, and trigger automation.
// ============================================================

const logger = createLogger('chat-orchestrator');

type WorkflowMatch = {
  siteId: string;
  workflowName: string;
  workflowKey?: string;
  trigger: string;
  score: number;
  lightweight?: boolean;
};

type ParsedChatDecision = {
  replyText?: string;
  threadTitle?: string;
  intent?: 'start_job' | 'provide_input' | 'chat' | 'manual_guidance' | 'cancel_task';
  jobDetails?: {
    site?: string;
    task?: string;
    profileToUse?: string | null;
    reasonToUseMemory?: string;
  };
  memory?: {
    shouldUseContext?: boolean;
    shouldUpdateSessionMemory?: boolean;
    profileHint?: string;
  };
  manualGuidance?: {
    taskLabel?: string;
    steps?: string[];
  };
  /** Rich UI to show next to the reply (see chat-ui.ts); validated before use. */
  ui?: unknown;
};

export interface ChatTurnContext {
  threadId?: string;
  generateTitle?: boolean;
  visibleJobs?: Array<{ id: string; title: string; company?: string; location?: string; url?: string; atsType?: string }>;
  recentApplications?: Array<{ id: string; title: string; company?: string | null; status: string }>;
}

type VisibleJob = NonNullable<ChatTurnContext['visibleJobs']>[number];
type VisibleApplyResolution =
  | { requested: false }
  | { requested: true; jobs: VisibleJob[]; clarify?: string; suggestions?: VisibleJob[] };

function safeChatContext(value?: ChatTurnContext): ChatTurnContext {
  const threadId = typeof value?.threadId === 'string' && /^[a-z0-9_-]{1,40}$/i.test(value.threadId)
    ? value.threadId
    : undefined;
  const visibleJobs = (Array.isArray(value?.visibleJobs) ? value.visibleJobs : []).slice(0, 8)
    .filter((job) => job && /^[0-9a-f-]{36}$/i.test(job.id) && typeof job.title === 'string' && job.title.trim())
    .map((job) => ({
      id: job.id,
      title: job.title.trim().slice(0, 160),
      company: typeof job.company === 'string' ? job.company.trim().slice(0, 100) : undefined,
      location: typeof job.location === 'string' ? job.location.trim().slice(0, 100) : undefined,
      url: typeof job.url === 'string' && /^https?:\/\//i.test(job.url) ? job.url.slice(0, 500) : undefined,
      atsType: typeof job.atsType === 'string' ? job.atsType.slice(0, 40) : undefined,
    }));
  const recentApplications = (Array.isArray(value?.recentApplications) ? value.recentApplications : []).slice(0, 8)
    .filter((app) => app && /^[0-9a-f-]{36}$/i.test(app.id) && typeof app.title === 'string')
    .map((app) => ({ id: app.id, title: app.title.slice(0, 160), company: typeof app.company === 'string' ? app.company.slice(0, 100) : null, status: String(app.status).slice(0, 40) }));
  return { threadId, generateTitle: value?.generateTitle === true, visibleJobs, recentApplications };
}

function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function resolveVisibleApply(message: string, jobs: VisibleJob[]): VisibleApplyResolution {
  if (!/\b(apply|applying)\b/i.test(message)
    || /^(?:how|can i|does jobpilot|does this app|will jobpilot)\b/i.test(message.trim())
    || /\b(?:should i apply|which (?:job|role) should i apply|what job should i apply)\b/i.test(message)) {
    return { requested: false };
  }
  if (!jobs.length) return { requested: false };

  const normalized = normalizeText(message);
  const isBatch = /\b(all|each|every|visible|these|those|them)\b/i.test(message);
  if (isBatch) {
    const count = normalized.match(/\b(?:all|these|those) (\d+)\b/)?.[1];
    const requestedCount = count && Number(count) > 0 ? Math.min(Number(count), jobs.length) : jobs.length;
    return { requested: true, jobs: jobs.slice(0, requestedCount) };
  }

  const ordinal = normalized.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th)\b/)?.[1];
  const order = ordinal ? ({ first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4, sixth: 5, '6th': 5 } as Record<string, number>)[ordinal] : undefined;
  if (order !== undefined && jobs[order]) return { requested: true, jobs: [jobs[order]] };

  const messageWords = new Set(normalized.split(' ').filter((word) => !['apply', 'applying', 'for', 'me', 'to', 'in', 'on', 'the', 'a', 'an', 'job', 'role', 'please', 'can', 'you', 'this', 'that'].includes(word)));
  const matches = jobs.filter((job) => {
    const titleWords = normalizeText(job.title).split(' ').filter((word) => word.length > 1);
    return normalized.includes(normalizeText(job.title)) || (titleWords.length > 0 && titleWords.every((word) => messageWords.has(word)));
  });
  if (matches.length === 1) return { requested: true, jobs: matches };
  if (matches.length > 1) return { requested: true, jobs: [], clarify: 'I found a few jobs that could match. Choose the right listing below; I’ll start its application when you tap “Apply for me”.', suggestions: matches };
  if (jobs.length === 1 && /\b(this|that|selected)\b/i.test(message)) return { requested: true, jobs: [jobs[0]] };

  const ignored = new Set(['apply', 'applying', 'for', 'me', 'to', 'in', 'on', 'the', 'a', 'an', 'job', 'jobs', 'role', 'roles', 'please', 'can', 'you', 'this', 'that', 'selected', 'review', 'approval', 'approve', 'before', 'start', 'all', 'each', 'every', 'visible', 'here']);
  const queryWords = normalizeText(message).split(' ').filter((word) => word.length > 1 && !ignored.has(word));
  const ranked = jobs.map((job) => {
    const candidates = normalizeText(`${job.title} ${job.company ?? ''} ${job.location ?? ''}`).split(' ');
    const scores = queryWords.map((word) => Math.max(0, ...candidates.map((candidate) => editSimilarity(word, candidate))));
    const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    const coverage = scores.length ? scores.filter((score) => score >= 0.66).length / scores.length : 0;
    return { job, score: average * 0.65 + coverage * 0.35 };
  }).filter((item) => item.score >= 0.58).sort((a, b) => b.score - a.score);
  if (ranked.length === 1 && ranked[0].score >= 0.76) return { requested: true, jobs: [ranked[0].job] };
  if (ranked.length > 0) {
    const closest = ranked.filter((item) => item.score >= ranked[0].score - 0.16).slice(0, 6).map((item) => item.job);
    return { requested: true, jobs: [], clarify: 'I’m not fully sure which role you meant. Choose the right listing below and I’ll start that application.', suggestions: closest };
  }
  return { requested: true, jobs: [], clarify: 'Which job should I apply to? Choose one of the roles shown below.', suggestions: jobs.slice(0, 6) };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isSimpleGreeting(message: string): boolean {
  return /^(?:hi|hello|hey|hiya|good morning|good afternoon|good evening)(?: there)?(?: jobpilot)?[.!?]*$/i.test(message.trim());
}

async function getGreetingName(userId: string): Promise<string | null> {
  const profiles = await memoryService.getProfiles(userId).catch(() => []);
  const profile = profiles.find((item) => item.profileName.toLowerCase() === 'default') ?? profiles[0];
  if (!profile) return null;
  const entry = Object.entries(profile.data).find(([key]) => /^(first[_ ]?name|full[_ ]?name|name)$/i.test(key));
  const firstName = entry?.[1]?.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, '');
  return firstName && firstName.length <= 40 ? firstName : null;
}

function needsWorkflowContext(message: string): boolean {
  const action = /\b(update|change|correct|download|renew|register|book|cancel|submit|fill(?: in| out)?|check|track|replace|order|pay|transfer|close|open|apply|schedule|upload|print|verify|recover|find|delete|remove|create|connect|disconnect|edit|retrieve|set up)\b/i.test(message);
  const jobpilotFeature = /\b(jobs?|roles?|openings?|resume|résumé|cv|career|interview|profile|application status|job application|account|inbox|auto apply|dashboard)\b/i.test(message);
  return action && !jobpilotFeature;
}

function needsProfileContext(message: string): boolean {
  return /\b(my|our|saved)\b.{0,35}\b(profile|resume|résumé|cv|background|experience|skills|work history|details)\b|\b(profile|resume|résumé|cv|background|experience|skills|work history)\b|\b(tailor|personalize|personalise)\b/i.test(message)
    || /\b(what should i (say|answer|write)|application question|cover letter)\b/i.test(message);
}

function needsFileContext(message: string): boolean {
  return /\b(resume|résumé|cv|uploaded files?|attachments?|documents?|signature|photo|cover letter|my files|files?)\b/i.test(message)
    && /\b(use|from|with|find|show|list|have|read|check|update|change|tailor|attach|upload|apply|draft|write|review|summari[sz]e)\b/i.test(message);
}

const WORKFLOW_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'my', 'your', 'please', 'can', 'you', 'help', 'want', 'need', 'how', 'what', 'do', 'to', 'on', 'in', 'a', 'an', 'is', 'me']);

function scoreWorkflow(message: string, workflow: SiteWorkflow): number {
  const query = normalizeText(message);
  const labels = [workflow.name, workflow.trigger, ...(workflow.triggerPhrases ?? [])].filter(Boolean);
  let score = 0;
  for (const label of labels) {
    const normalized = normalizeText(label);
    if (normalized.length > 2 && query.includes(normalized)) score += 20 + normalized.length;
  }
  const queryWords = new Set(query.split(' ').filter((word) => word.length > 2 && !WORKFLOW_STOP_WORDS.has(word)));
  const labelWords = new Set(labels.flatMap((label) => normalizeText(label).split(' ')).filter((word) => word.length > 2 && !WORKFLOW_STOP_WORDS.has(word)));
  for (const word of queryWords) if (labelWords.has(word)) score += 3;
  for (const input of workflow.requiredInputs ?? []) {
    const normalizedInput = normalizeText(input.replace(/_/g, ' '));
    if (normalizedInput.length > 2 && query.includes(normalizedInput)) score += 2;
  }
  return score;
}

function rankWorkflowCandidates(message: string, workflows: SiteWorkflow[], limit = 8): SiteWorkflow[] {
  const ranked = workflows
    .filter((workflow) => workflow.status === 'published')
    .map((workflow) => ({ workflow, score: scoreWorkflow(message, workflow) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.workflow.name.localeCompare(b.workflow.name));
  // On low-signal action requests retain the broad catalog as a recall fallback.
  // Strong lexical matches are narrowed to a handful of likely workflows.
  if (!ranked.length || ranked[0].score < 20) return workflows.filter((workflow) => workflow.status === 'published').slice(0, 50);
  return ranked.slice(0, limit).map((entry) => entry.workflow);
}

export function shouldDisableContextMemory(message: string): boolean {
  return /don't use context memory|do not use context memory|dont use memory|do not use memory|forget context|without memory/i.test(message);
}

export function shouldEnableContextMemory(message: string): boolean {
  return /use context memory|use memory|remember context|use my saved details/i.test(message);
}

/**
 * A short, direct order to stop ("cancel", "please stop the task"). A longer sentence that merely contains the word
 * ("don't stop now", "how do I cancel my subscription?") must not end a running application.
 */
export function shouldCancelTask(message: string): boolean {
  const m = message.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!m || m.split(' ').length > 6 || /\b(not|don't|dont|never|why|how|what|when|can't|cant)\b/.test(m)) return false;
  return /^(please |pls |can you |could you )?(stop|cancel|pause|abort|end)( (it|this|that|now|task|the task|the application|my application|everything))?( now| please| pls)?$/.test(m);
}

function formatWorkflowSummary(workflows: SiteWorkflow[]): string {
  if (!workflows.length) return 'No active workflows available.';
  return workflows
    .filter((workflow) => workflow.status === 'published')
    .slice(0, 50)
    .map((workflow) => JSON.stringify({
      siteId: workflow.siteId,
      name: workflow.name,
      trigger: workflow.trigger,
      triggerPhrases: (workflow.triggerPhrases ?? []).slice(0, 4),
      portalType: workflow.portalType ?? null,
      requiredInputs: workflow.requiredInputs ?? [],
    }))
    .join('\n');
}

async function findMatchingWorkflow(task: string, available?: SiteWorkflow[]): Promise<WorkflowMatch | null> {
  const normalizedTask = normalizeText(task);
  const workflows = available ?? await siteWorkflowService.listAll();
  let best: WorkflowMatch | null = null;

  for (const workflow of workflows) {
    if (workflow.status !== 'published') continue;
    let score = 0;
    const trigger = normalizeText(workflow.trigger);
    const name = normalizeText(workflow.name);
    if (trigger && normalizedTask.includes(trigger)) score += 10;
    if (name && normalizedTask.includes(name)) score += 7;
    for (const phrase of workflow.triggerPhrases ?? []) {
      const normalizedPhrase = normalizeText(phrase);
      if (normalizedPhrase && normalizedTask.includes(normalizedPhrase)) score += 8;
    }
    for (const input of workflow.requiredInputs ?? []) {
      if (normalizedTask.includes(input.replace(/_/g, ' '))) score += 1;
    }

    if (!best || score > best.score) {
      best = {
        siteId: workflow.siteId,
        workflowName: workflow.name,
        workflowKey: workflow.workflowKey ?? undefined,
        trigger: workflow.trigger,
        score,
        lightweight: workflow.metadata?.lightweight as boolean | undefined,
      };
    }
  }

  return best && best.score > 0 ? best : null;
}

function buildManualGuidanceReply(parsed: ParsedChatDecision, originalMessage: string): string {
  const steps = parsed.manualGuidance?.steps?.filter(Boolean) ?? [];
  if (!steps.length) {
    return `Which website or service is this for, and what exactly do you want done? I'll walk you through it step by step.`;
  }
  return `${parsed.replyText ?? `Here's how to do it:`}\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
}

/**
 * Zero-token fast path: when a job is paused for input and the message is
 * plainly that input (OTP digits, a captcha answer, "yes", an email/phone),
 * resume directly instead of asking the LLM to classify it.
 */
export function looksLikeRequestedInput(type: string, message: string): boolean {
  const m = message.trim();
  if (!m || m.length > 120) return false;
  switch (type) {
    case 'otp':
    case 'mfa':
      return /^\d{4,8}$/.test(m.replace(/\s/g, ''));
    case 'captcha':
      return /^[A-Za-z0-9]{3,10}$/.test(m);
    case 'confirmation':
      return /^(yes|y|ok|okay|done|paid|confirm(ed)?|go ahead|proceed|haan|ha)\.?!?$/i.test(m);
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m);
    case 'mobile':
      return /^\+?[\d\s-]{10,16}$/.test(m);
    case 'upi_id':
      return /^[\w.-]{2,}@[a-z]{2,}$/i.test(m);
    default:
      return false;
  }
}

/** Keep the routing prompt small: only the most recent turns go to the model. */
const ROUTING_HISTORY_TURNS = 10;

export class ChatOrchestrator {
  /**
   * Main entry point for a new chat message
   */
  async handleMessage(
    userId: string, 
    sessionId: string, 
    message: string, 
    replyCallback: (msg: string) => void,
    jobStartedCallback?: (payload: { jobId: string; siteId: string; task: string; sessionId: string; userId: string }) => void,
    uiCallback?: (cards: UiCard[]) => void,
    rawChatContext?: ChatTurnContext,
    titleCallback?: (threadId: string, title: string) => void,
  ): Promise<void> {
    const chatContext = safeChatContext(rawChatContext);
    const state = await this.getState(userId, sessionId);
    let workflowSummaryForTurn = 'No matching workflow candidates.';
    let profileSummaryForTurn = 'No profile context was needed for this request.';
    let workflowsForTurn: SiteWorkflow[] | undefined;
    let workflowCandidates: SiteWorkflow[] = [];

    // Codes, Aadhaar, phone numbers, PINs and passwords go straight to the browser run: never to the
    // model, never into the chat history, never stored. Checked by format in code.
    if (state.awaitingInput && state.activeJobId && !shouldCancelTask(message) && SENSITIVE_INPUT.has(state.awaitingInput.type)) {
      if (!fitsSensitiveInput(state.awaitingInput.type, message)) {
        const reply = 'That doesn’t look right for what I asked — please type it again. (Only the site sees it, never the AI.)';
        state.history.push({ role: 'user', content: '[hidden]' });
        state.history.push({ role: 'assistant', content: reply });
        await this.saveState(state);
        replyCallback(reply);
        return;
      }
      await this.resumeJob(state.activeJobId, message.trim());
      state.awaitingInput = undefined;
      state.history.push({ role: 'user', content: '[hidden]' });
      const reply = 'Got it — entered on the site, continuing.';
      state.history.push({ role: 'assistant', content: reply });
      await this.saveState(state);
      replyCallback(reply);
      return;
    }

    if (shouldDisableContextMemory(message)) {
      state.memoryContext.useContextMemory = false;
      await this.saveState(state);
      const reply = 'Got it 👍 I won\'t use your saved context memory until you ask me to again.';
      state.history.push({ role: 'user', content: message });
      state.history.push({ role: 'assistant', content: reply });
      await this.saveState(state);
      replyCallback(reply);
      return;
    }

    if (shouldEnableContextMemory(message)) {
      state.memoryContext.useContextMemory = true;
      await this.saveState(state);
      const reply = 'Sure thing ✅ I\'ll use your saved details and recent context when needed.';
      state.history.push({ role: 'user', content: message });
      state.history.push({ role: 'assistant', content: reply });
      await this.saveState(state);
      replyCallback(reply);
      return;
    }

    if (shouldCancelTask(message) && state.activeJobId) {
      const cancelledJobId = state.activeJobId;
      const redis = await getRedisClient();
      await redis.setEx(CacheKeys.jobCancel(cancelledJobId), 86400, '1');
      await redis.publish(`job:cancel:${cancelledJobId}`, 'cancel');
      state.awaitingInput = undefined;
      state.activeJobId = undefined;
      state.memoryContext.taskCancelledAt = new Date().toISOString();
      const reply = 'The current task has been stopped. Let me know if you\'d like to start again. 🛑';
      state.history.push({ role: 'user', content: message });
      state.history.push({ role: 'assistant', content: reply });
      await this.saveState(state);
      replyCallback(reply);
      return;
    }

    // Only fast-path a clear opening greeting. In an established conversation,
    // or while a task is active, let the model use the conversation context.
    if (!state.history.length && !state.activeJobId && !state.awaitingInput && isSimpleGreeting(message)) {
      const name = state.memoryContext.useContextMemory === false ? null : await getGreetingName(userId);
      const greeting = name
        ? `Hi ${name}, good to have you here. I can help with jobs, applications, résumés, and interview prep. What would you like to work on?`
        : `Hi! I can help with jobs, applications, résumés, and interview prep. What would you like to work on?`;
      state.history.push({ role: 'user', content: message });
      state.history.push({ role: 'assistant', content: greeting });
      await this.saveState(state);
      logger.info('chat:fast-path', { kind: 'greeting' });
      replyCallback(greeting);
      return;
    }
    
    // Add user message to history
    state.history.push({ role: 'user', content: message });

    if (state.awaitingInput && state.activeJobId && looksLikeRequestedInput(state.awaitingInput.type, message)) {
      await memoryService.storeEphemeralData(
        userId,
        `job:${state.activeJobId}:input:${state.awaitingInput.stepId}`,
        message,
        900,
      );
      await this.resumeJob(state.activeJobId, message.trim());
      state.awaitingInput = undefined;
      state.memoryContext.lastUserInput = message;
      const reply = 'Got it — continuing.';
      state.history.push({ role: 'assistant', content: reply });
      await this.saveState(state);
      replyCallback(reply);
      return;
    }

    // (Removed blind input assumption. The LLM will now classify if this is the requested input or a chat question)

    // "Apply … <job link>" goes straight to the apply engine — no LLM needed.
    const jobLink = message.match(/https?:\/\/[^\s)"']+/)?.[0];
    if (jobLink && /\bapply\b/i.test(message)) {
      let reply: string;
      try {
        const started = await startApplication(userId, { url: jobLink, sessionId, source: 'chat', stopBeforeSubmit: /\b(review|approval|approve|check before|pause before)\b/i.test(message) || undefined });
        state.activeJobId = started.application.exec_job_id;
        jobStartedCallback?.({ jobId: started.application.exec_job_id, siteId: '', task: started.application.title, sessionId, userId });
        reply = `On it — filling the application${started.application.company ? ` for ${started.application.company}` : ''} from your profile. I'll ask if a question needs you, and show you everything before it's submitted.`;
      } catch (err) {
        if (!(err instanceof ApplyError || err instanceof LimitError || err instanceof InsufficientCreditsError)) throw err;
        reply = err.message;
      }
      state.history.push({ role: 'assistant', content: reply });
      await this.saveState(state);
      replyCallback(reply);
      return;
    }

    const visibleApply = resolveVisibleApply(message, chatContext.visibleJobs ?? []);
    if (visibleApply.requested) {
      if (!visibleApply.jobs.length) {
        const clarification = visibleApply.clarify ?? 'Which job should I apply to? Choose one of the roles shown below.';
        const candidates = visibleApply.suggestions ?? chatContext.visibleJobs ?? [];
        state.history.push({ role: 'assistant', content: clarification });
        await this.saveState(state);
        replyCallback(clarification);
        const suggestionListings = await Promise.all(candidates.map(async (job) => {
          const row = await getJob(job.id).catch(() => null);
          return row ? toListing(row) : null;
        }));
        const suggestions = suggestionListings.filter((job): job is NonNullable<typeof job> => Boolean(job));
        if (suggestions.length) uiCallback?.([{ type: 'jobs', title: 'Choose a job to apply for', jobs: suggestions }]);
        return;
      }
      const review = /\b(review|approval|approve|check before|pause before)\b/i.test(message);
      const started: string[] = [];
      const failed: string[] = [];
      for (const job of visibleApply.jobs) {
        try {
          const result = await startApplication(userId, {
            jobId: job.id,
            sessionId,
            source: 'chat',
            checkProfile: true,
            stopBeforeSubmit: review || undefined,
          });
          state.activeJobId = result.application.exec_job_id;
          started.push(job.title);
          jobStartedCallback?.({ jobId: result.application.exec_job_id, siteId: '', task: result.application.title, sessionId, userId });
        } catch (error) {
          const rawReason = error instanceof Error ? error.message : 'Could not start this application';
          const reason = /no application workflow is published/i.test(rawReason)
            ? 'Automatic application filling is not available for this employer yet.'
            : rawReason;
          failed.push(`${job.title}: ${reason}`);
          logger.info('chat:visible-job-apply-failed', { userId, jobId: job.id, reason });
        }
      }
      const reply = started.length
        ? `${started.length === 1 ? `I queued the application for ${started[0]}.` : `I queued applications for ${started.length} roles: ${started.join(', ')}.`}${started.length > 1 ? ' They’ll run one at a time, with live progress in Applications.' : ''}${review ? ' It will pause for your review before anything is submitted.' : ''}${failed.length ? `\n\nI couldn’t start these:\n${failed.map((line) => `- ${line}`).join('\n')}` : ''}`
        : `I couldn’t start these applications, so nothing was submitted:\n${failed.map((line) => `- ${line}`).join('\n')}`;
      state.history.push({ role: 'assistant', content: reply });
      await this.saveState(state);
      replyCallback(reply);
      if (started.length) uiCallback?.([{ type: 'open', view: 'tasks', label: 'View application progress' }]);
      return;
    }

    // Classify intent via LLM — always use the real AI provider
    try {
      const shouldUseContext = state.memoryContext.useContextMemory !== false;
      const includeProfile = shouldUseContext && needsProfileContext(message);
      const includeFiles = shouldUseContext && needsFileContext(message);
      const includeWorkflows = needsWorkflowContext(message);
      const profileSummary = includeProfile
        ? await memoryService.summarizeProfiles(userId)
        : shouldUseContext ? '' : 'User has asked not to use saved context.';
      const fileSummary = includeFiles ? await fileStorageService.summarizeFiles(userId) : '';
      if (includeWorkflows) {
        workflowsForTurn = await siteWorkflowService.listAll();
        workflowCandidates = rankWorkflowCandidates(message, workflowsForTurn);
      }
      const workflowSummary = workflowCandidates.length ? formatWorkflowSummary(workflowCandidates) : '';
      workflowSummaryForTurn = workflowSummary;
      profileSummaryForTurn = profileSummary;
      const needsSessionMemory = Boolean(state.activeJobId || state.awaitingInput)
        || /\b(it|that|same|continue|again|previous|last one)\b/i.test(message);
      const sessionMemorySummary = needsSessionMemory ? JSON.stringify({
        activeTask: state.memoryContext.task?.slice(0, 240) ?? null,
        activeSiteId: state.memoryContext.siteId ?? null,
        profileHint: state.memoryContext.lastProfileHint ?? null,
        currentlyAwaitingInputFor: state.awaitingInput?.type ?? null,
      }) : '';

      const includeChatContext = /\b(job|jobs|role|roles|application|apply|these|those|visible|it|that)\b/i.test(message);
      const currentChat = includeChatContext ? [
        chatContext.visibleJobs?.length
          ? `CURRENT JOB RESULTS SHOWN IN CHAT:\n${chatContext.visibleJobs.map((job, i) => `${i + 1}. ${JSON.stringify({ id: job.id, title: job.title, company: job.company, location: job.location, url: job.url, atsType: job.atsType })}`).join('\n')}`
          : '',
        chatContext.recentApplications?.length
          ? `RECENT APPLICATIONS:\n${chatContext.recentApplications.map((app) => JSON.stringify(app)).join('\n')}`
          : '',
      ].filter(Boolean).join('\n\n') : '';
      const contextSections = [
        workflowSummary ? `ACTIVE WORKFLOW CANDIDATES:\n${workflowSummary}` : '',
        profileSummary ? `USER PROFILES:\n${profileSummary}` : '',
        fileSummary ? `USER FILES:\n${fileSummary}` : '',
        sessionMemorySummary ? `SESSION MEMORY:\n${sessionMemorySummary}` : '',
        currentChat,
      ].filter(Boolean);
      const contextMessage = contextSections.length
        ? `RELEVANT TURN CONTEXT (use only what applies):\n${contextSections.join('\n\n')}`
        : '';
      const routeMessages = [
        { role: 'system' as const, content: FORMKARO_SYSTEM_PROMPT },
        ...(chatContext.generateTitle ? [{ role: 'system' as const, content: 'GENERATE_CHAT_TITLE: include a concise threadTitle field in your JSON response.' }] : []),
        ...(contextMessage ? [{ role: 'system' as const, content: contextMessage }] : []),
        ...state.history.slice(-ROUTING_HISTORY_TURNS).map((h) => ({ role: h.role, content: h.content })),
      ];
      const promptChars = routeMessages.reduce((sum, item) => sum + item.content.length, 0);
      const contextChars = contextMessage.length;

      let responseContent: string | null = null;
      let routeUsage: {
        model: string;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        cacheWriteTokens: number;
        costUsd: number;
        latencyMs: number;
      } | null = null;
      try {
        const requestStartedAt = Date.now();
        const res = await complete({
          purpose: 'chat_route',
          json: true,
          maxTokens: 700,
          userId,
          timeoutMs: 30_000,
          messages: routeMessages,
        });
        responseContent = res.text;
        routeUsage = {
          model: res.model,
          inputTokens: res.usage.prompt,
          outputTokens: res.usage.completion,
          cachedTokens: res.usage.cached,
          cacheWriteTokens: res.usage.cacheWrite,
          costUsd: res.costUsd,
          latencyMs: Date.now() - requestStartedAt,
        };
      } catch (err: any) {
        logger.error('llm:chat-orchestration-failed', {
          userId,
          sessionId,
          messagePreview: message.slice(0, 100),
          errorName: err.name,
          errorMessage: err.message,
        });
        let errorMsg = "Sorry, I'm having trouble reaching the AI right now. Please try again in a moment. 🔌";
        if (err instanceof LLMBlockedError) {
          errorMsg = err.reason === 'user_budget'
            ? "You've used today's AI allowance. Tasks already running keep going; chat comes back tomorrow."
            : "The assistant is paused right now. Tasks already running keep going.";
        } else if (err.message && err.message.includes('429')) {
          errorMsg = "The AI provider is busy right now. Please wait a minute and try again! ⏳";
        }
        replyCallback(errorMsg);
        return;
      }

      let content = typeof responseContent === 'string' ? responseContent : '{}';

      // Extract JSON from potential reasoning output (e.g. <think>...</think>)
      content = content.trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        content = jsonMatch[0];
      }

      let parsed: ParsedChatDecision;
      try {
        parsed = JSON.parse(content.trim()) as ParsedChatDecision;
      } catch {
        // Model returned plain text instead of JSON — wrap it as a chat reply
        logger.warn('llm:non-json-response', { rawContent: content.slice(0, 200) });
        parsed = { replyText: responseContent ?? "I'm here to help! What would you like to do? 😊", intent: 'chat' };
      }

      const generatedTitle = typeof parsed.threadTitle === 'string'
        ? parsed.threadTitle.replace(/[\r\n\"“”]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48)
        : '';
      if (chatContext.generateTitle && generatedTitle && chatContext.threadId && titleCallback) {
        titleCallback(chatContext.threadId, generatedTitle);
      }

      logger.info('chat:route-metrics', {
        intent: parsed.intent ?? 'chat',
        model: routeUsage?.model ?? null,
        inputTokens: routeUsage?.inputTokens ?? null,
        outputTokens: routeUsage?.outputTokens ?? null,
        cachedTokens: routeUsage?.cachedTokens ?? null,
        cacheWriteTokens: routeUsage?.cacheWriteTokens ?? null,
        trackedCostUsd: routeUsage?.costUsd ?? null,
        latencyMs: routeUsage?.latencyMs ?? null,
        promptChars,
        contextChars,
        workflowCandidates: workflowCandidates.length,
        workflowCatalogFallback: workflowCandidates.length > 8,
        profileContextIncluded: includeProfile,
        fileContextIncluded: includeFiles,
        historyMessages: routeMessages.length - 1 - (contextMessage ? 1 : 0),
      });

      if (parsed.memory?.shouldUseContext === false) {
        state.memoryContext.useContextMemory = false;
      } else if (parsed.memory?.shouldUseContext === true) {
        state.memoryContext.useContextMemory = true;
      }

      if (parsed.memory?.profileHint) {
        state.memoryContext.lastProfileHint = parsed.memory.profileHint;
      }

      const cards = parsed.ui ? await resolveUi(userId, parsed.ui, { message, history: state.history }) : [];
      const jobCard = cards.find((card): card is Extract<UiCard, { type: 'jobs' }> => card.type === 'jobs');
      let replyText = parsed.replyText || 'I\'m here to help! What would you like to do?';
      if (jobCard) {
        replyText = jobCard.jobs.length
          ? jobCard.broadened
            ? `I widened the search a little to find relevant roles. Take a look at these, and you can browse more similar jobs at the end.`
            : `Here are roles that fit your search. You can browse more similar jobs at the end.`
          : `I couldn't find active roles for those filters right now. You can broaden the search or browse all jobs below.`;
      }
      const deferReply = (parsed.intent === 'start_job' && Boolean(parsed.jobDetails?.task)) || parsed.intent === 'manual_guidance';
      if (!deferReply) {
        state.history.push({ role: 'assistant', content: replyText });
        replyCallback(replyText);
        if (uiCallback && cards.length) uiCallback(cards);
      }

      if (parsed.intent === 'cancel_task' && state.activeJobId) {
        const cancelledJobId = state.activeJobId;
        const redis = await getRedisClient();
        await redis.setEx(CacheKeys.jobCancel(cancelledJobId), 86400, '1');
        await redis.publish(`job:cancel:${cancelledJobId}`, 'cancel');
        state.awaitingInput = undefined;
        state.activeJobId = undefined;
        state.memoryContext.taskCancelledAt = new Date().toISOString();
        await this.saveState(state);
        return;
      }

      if (parsed.intent === 'provide_input' && state.awaitingInput && state.activeJobId) {
        await memoryService.storeEphemeralData(
          userId,
          `job:${state.activeJobId}:input:${state.awaitingInput.stepId}`,
          message,
          900
        );
        await this.resumeJob(state.activeJobId, message);
        state.awaitingInput = undefined;
        state.memoryContext.lastUserInput = message;
        await this.saveState(state);
        return;
      }

      if (parsed.intent === 'manual_guidance') {
        const manualReply = buildManualGuidanceReply(parsed, message);
        state.history.push({ role: 'assistant', content: manualReply });
        replyCallback(manualReply);
        if (uiCallback && cards.length) uiCallback(cards);
        await this.saveState(state);
        return;
      }

      // Handle Job Start
      if (parsed.intent === 'start_job' && parsed.jobDetails?.task) {
        const workflowMatch = await findMatchingWorkflow(parsed.jobDetails.task, workflowsForTurn);
        if (!workflowMatch) {
          logger.warn('workflow:missing-for-task', {
            userId,
            sessionId,
            message,
            suggestedTask: parsed.jobDetails.task,
          });
          const unavailable = 'I couldn’t start this application because there is no matching application workflow for it yet. No application was created. Use “Apply for me” on a job card to start a supported application.';
          state.history.push({ role: 'assistant', content: unavailable });
          replyCallback(unavailable);
          await this.saveState(state);
          return;
        }

        // Admin-set limits (daily / concurrent) before anything starts.
        try {
          await applicationsService.assertCanStart(userId);
        } catch (err) {
          if (err instanceof LimitError) {
            state.history.push({ role: 'assistant', content: err.message });
            replyCallback(err.message);
            await this.saveState(state);
            return;
          }
          throw err;
        }

        const taskTitle = parsed.jobDetails.task.split('\n')[0].slice(0, 200);
        const taskUrl = message.match(/https?:\/\/[^\s)]+/)?.[0] ?? null;
        let taskInstruction = parsed.jobDetails.task;
        
        // Append profile data if requested
        if (parsed.jobDetails.profileToUse) {
          const profile = await memoryService.getProfileByName(userId, parsed.jobDetails.profileToUse);
          if (profile) {
            taskInstruction += `\nUse the following details: ${JSON.stringify(profile.data)}`;
          } else {
            replyCallback(`I couldn't find a saved profile named '${parsed.jobDetails.profileToUse}'. I'll try to continue without it. 🙏`);
          }
        }

        const savedFiles = await fileStorageService.summarizeFiles(userId);
        taskInstruction += `\nAvailable uploaded files for automation:\n${savedFiles}`;
        taskInstruction += `\nMatched workflow: ${workflowMatch.workflowName} (${workflowMatch.siteId})`;

        const job: ExecuteJob = {
          id: randomUUID(),
          type: 'execute',
          priority: 'normal',
          createdAt: new Date(),
          userId,
          sessionId,
          payload: {
            siteId: workflowMatch.siteId,
            task: taskInstruction,
            workflowKey: workflowMatch.workflowKey,
            sessionId,
            useCache: false,
            lightweight: workflowMatch.lightweight
          }
        };

        let jobId: string;
        try {
          jobId = await enqueueJob(job);
        } catch (err) {
          if (!(err instanceof DuplicateTaskError)) throw err;
          const msg = 'That task is already running on your account — I haven\'t started a second copy. You can follow or cancel the running one.';
          state.activeJobId = err.existingJobId;
          state.history.push({ role: 'assistant', content: msg });
          replyCallback(msg);
          await this.saveState(state);
          return;
        }
        await applicationsService
          .create({ userId, title: taskTitle, url: taskUrl, execJobId: jobId, sessionId, company: null })
          .catch((err) => logger.error('application:create-failed', err, { jobId }));
        state.activeJobId = jobId;
        state.memoryContext.siteId = parsed.jobDetails.site;
        state.memoryContext.task = taskInstruction;
        await this.saveJobRuntimeState({
          jobId,
          userId,
          sessionId,
          siteId: workflowMatch.siteId,
          task: taskInstruction,
          status: 'queued',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        jobStartedCallback?.({
          jobId,
          siteId: workflowMatch.siteId,
          task: taskInstruction,
          sessionId,
          userId,
        });

        // Only show the model's start message and its shortcuts after the
        // workflow has actually been matched and the task has been queued.
        if (deferReply) {
          state.history.push({ role: 'assistant', content: replyText });
          replyCallback(replyText);
          if (uiCallback && cards.length) uiCallback(cards);
        }

        // Check queue position and notify user
        try {
          const position = await getJobPosition('execute', jobId);
          if (position !== null && position > 0) {
            const estimatedMins = Math.max(1, Math.ceil(position * 1.5));
            replyCallback(`Your task is queued, ${position} tasks ahead of you, estimated wait ${estimatedMins} minute${estimatedMins > 1 ? 's' : ''}.`);
          }
        } catch (e) {
          logger.error('failed-to-get-queue-position', e);
        }
      }

      await this.saveState(state);
    } catch (err) {
      logger.error('llm:chat-orchestration-failed', err, { userId, sessionId, messagePreview: message.slice(0, 160) });
      replyCallback("Sorry, I had trouble understanding your request. Could you try rephrasing it? I'm here to help. 🙏");
    }
  }

  /**
   * Called by the Execution engine via Redis pub/sub when a job pauses for OTP/CAPTCHA
   */
  async handleJobPauseRequest(
    userId: string, 
    sessionId: string, 
    jobId: string, 
    stepId: string, 
    type: import('../shared/types/index.js').InputCardKind,
    contextMessage: string,
    replyCallback: (msg: string) => void
  ) {
    const state = await this.getState(userId, sessionId);
    state.activeJobId = jobId;
    state.awaitingInput = { jobId, stepId, type, contextMessage };
    state.history.push({ role: 'assistant', content: contextMessage });
    await this.saveState(state);
    await this.saveJobRuntimeState({
      jobId,
      userId,
      sessionId,
      siteId: state.memoryContext.siteId as string ?? 'unknown',
      task: state.memoryContext.task as string ?? '',
      status: 'paused',
      activeStepId: stepId,
      lastInputType: type,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    replyCallback(contextMessage);
  }

  private async resumeJob(jobId: string, input: string) {
    // Parked applications continue in a new run; live ones get the value directly.
    await resumeExecJob(jobId, input);
  }

  // ─── State Management ────────────────────────────────────────

  private async getState(userId: string, sessionId: string): Promise<ConversationState> {
    const redis = await getRedisClient();
    const key = `chat-state:${userId}:${sessionId}`;
    const data = await redis.get(key);
    if (data) {
      return JSON.parse(data) as ConversationState;
    }
    return {
      userId,
      sessionId,
      history: [],
      memoryContext: {},
      lastUpdated: new Date()
    };
  }

  private async saveState(state: ConversationState): Promise<void> {
    const redis = await getRedisClient();
    const key = `chat-state:${state.userId}:${state.sessionId}`;
    state.lastUpdated = new Date();
    // Bound stored history; only the last ROUTING_HISTORY_TURNS are sent to the model anyway.
    if (state.history.length > 40) state.history = state.history.slice(-40);
    await redis.setEx(key, 86400, JSON.stringify(state)); // 24 hour TTL
  }

  private async saveJobRuntimeState(state: JobRuntimeState): Promise<void> {
    const redis = await getRedisClient();
    await redis.setEx(CacheKeys.jobRuntime(state.jobId), 86400, JSON.stringify(state));
  }
}

export const chatOrchestrator = new ChatOrchestrator();
