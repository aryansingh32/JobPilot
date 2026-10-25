import { getRedisClient, CacheKeys } from '../shared/db/index.js';
import { complete, completeJSON, LLMBlockedError } from '../shared/llm/gateway.js';
import { memoryService } from './user-memory.service.js';
import type { ConversationState, ExecuteJob, JobRuntimeState } from '../shared/types/index.js';
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

type ManualGuidanceDecision = {
  replyText?: string;
  steps?: string[];
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function shouldDisableContextMemory(message: string): boolean {
  return /don't use context memory|do not use context memory|dont use memory|do not use memory|forget context|without memory/i.test(message);
}

function shouldEnableContextMemory(message: string): boolean {
  return /use context memory|use memory|remember context|use my saved details/i.test(message);
}

function shouldCancelTask(message: string): boolean {
  return /\b(stop|cancel|pause|end task|abort)\b/i.test(message);
}

function formatWorkflowSummary(workflows: Awaited<ReturnType<typeof siteWorkflowService.listAll>>): string {
  if (!workflows.length) return 'No active workflows available.';
  return workflows
    .filter((workflow) => workflow.status === 'published')
    .slice(0, 50)
    .map((workflow) => JSON.stringify({
      siteId: workflow.siteId,
      name: workflow.name,
      trigger: workflow.trigger,
      triggerPhrases: workflow.triggerPhrases ?? [],
      portalType: workflow.portalType ?? null,
      requiredInputs: workflow.requiredInputs ?? [],
      requiredFiles: workflow.requiredFiles ?? [],
      entryUrl: workflow.entryUrl ?? null,
    }))
    .join('\n');
}

async function findMatchingWorkflow(task: string): Promise<WorkflowMatch | null> {
  const normalizedTask = normalizeText(task);
  const workflows = await siteWorkflowService.listAll();
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

async function generateManualGuidance(
  userMessage: string,
  workflowSummary: string,
  profileSummary: string,
  userId?: string,
): Promise<string> {
  const { data: parsed } = await completeJSON<ManualGuidanceDecision>({
    purpose: 'chat_answer',
    maxTokens: 700,
    userId,
    messages: [
      {
        role: 'system',
        content: `You are jobpilot, a personal job-application assistant. Give a helpful, accurate, step-by-step guide the user can follow right now for exactly what they asked, on whatever site or service is relevant.
Never mention automation, workflows, templates or internal tooling, and never say something can't be automated. Write as if guiding them was the plan. Always respond in English.
Return ONLY valid JSON:
{
  "replyText": "short empathetic intro",
  "steps": ["step 1", "step 2", "step 3"]
}`,
      },
      {
        role: 'user',
        content: `USER REQUEST:\n${userMessage}\n\nACTIVE WORKFLOWS:\n${workflowSummary}\n\nSAFE USER CONTEXT:\n${profileSummary}`,
      },
    ],
  });
  const intro = parsed.replyText ?? 'Here are the steps:';
  const steps = parsed.steps?.filter(Boolean) ?? [];
  if (!steps.length) return intro;
  return `${intro}\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
}

/**
 * Zero-token fast path: when a job is paused for input and the message is
 * plainly that input (OTP digits, a captcha answer, "yes", an email/phone),
 * resume directly instead of asking the LLM to classify it.
 */
function looksLikeRequestedInput(type: string, message: string): boolean {
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
  ): Promise<void> {
    const state = await this.getState(userId, sessionId);
    let workflowSummaryForTurn = 'No active workflows available.';
    let profileSummaryForTurn = 'No saved user profiles.';

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
        const started = await startApplication(userId, { url: jobLink, sessionId, source: 'chat' });
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

    // Classify intent via LLM — always use the real AI provider
    try {
      const shouldUseContext = state.memoryContext.useContextMemory !== false;
      const profileSummary = shouldUseContext
        ? await memoryService.summarizeProfiles(userId)
        : 'User requested no saved context memory for now.';
      const fileSummary = await fileStorageService.summarizeFiles(userId);
      const workflowSummary = formatWorkflowSummary(await siteWorkflowService.listAll());
      workflowSummaryForTurn = workflowSummary;
      profileSummaryForTurn = profileSummary;
      const sessionMemorySummary = JSON.stringify({
        useContextMemory: shouldUseContext,
        lastSiteId: state.memoryContext.siteId ?? null,
        lastTask: state.memoryContext.task ?? null,
        lastProfileHint: state.memoryContext.lastProfileHint ?? null,
        lastUserInput: state.memoryContext.lastUserInput ?? null,
        currentlyAwaitingInputFor: state.awaitingInput ? state.awaitingInput.type : null,
      });

      let responseContent: string | null = null;
      try {
        const res = await complete({
          purpose: 'chat_route',
          json: true,
          maxTokens: 700,
          userId,
          timeoutMs: 30_000,
          messages: [
            // Static prompt first and byte-identical every call → provider prefix caching.
            { role: 'system', content: FORMKARO_SYSTEM_PROMPT },
            { role: 'system', content: `ACTIVE WORKFLOWS:\n${workflowSummary}\n\nUSER PROFILES:\n${profileSummary}\n\nUSER FILES:\n${fileSummary}\n\nSESSION MEMORY:\n${sessionMemorySummary}` },
            ...state.history.slice(-ROUTING_HISTORY_TURNS).map((h) => ({ role: h.role, content: h.content })),
          ],
        });
        responseContent = res.text;
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

      if (parsed.memory?.shouldUseContext === false) {
        state.memoryContext.useContextMemory = false;
      } else if (parsed.memory?.shouldUseContext === true) {
        state.memoryContext.useContextMemory = true;
      }

      if (parsed.memory?.profileHint) {
        state.memoryContext.lastProfileHint = parsed.memory.profileHint;
      }

      const replyText = parsed.replyText || 'I\'m here to help! What would you like to do? 😊';
      state.history.push({ role: 'assistant', content: replyText });
      replyCallback(replyText);
      if (uiCallback && parsed.ui) {
        const cards = await resolveUi(userId, parsed.ui);
        if (cards.length) uiCallback(cards);
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
        if (manualReply !== replyText) {
          state.history.push({ role: 'assistant', content: manualReply });
          replyCallback(manualReply);
        }
        await this.saveState(state);
        return;
      }

      // Handle Job Start
      if (parsed.intent === 'start_job' && parsed.jobDetails?.task) {
        const workflowMatch = await findMatchingWorkflow(parsed.jobDetails.task);
        if (!workflowMatch) {
          logger.warn('workflow:missing-for-task', {
            userId,
            sessionId,
            message,
            suggestedTask: parsed.jobDetails.task,
          });
          const manualFallback = await generateManualGuidance(
            message,
            workflowSummaryForTurn,
            profileSummaryForTurn,
            userId,
          );
          state.history.push({ role: 'assistant', content: manualFallback });
          replyCallback(manualFallback);
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
