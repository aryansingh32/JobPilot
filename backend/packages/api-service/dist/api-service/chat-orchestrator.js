import { getRedisClient, CacheKeys } from '../shared/db/index.js';
import { getLLMProviderConfig, getOpenAICompatibleClient, getReasoningRequestBody } from '../shared/llm/index.js';
import { memoryService } from './user-memory.service.js';
import { enqueueJob, getJobPosition } from '../shared/queue/index.js';
import { randomUUID } from 'crypto';
import { fileStorageService } from './file-storage.service.js';
import { siteWorkflowService } from './site-workflow.service.js';
import { FORMKARO_SYSTEM_PROMPT } from './prompts/formkaro-chat.js';
import { createLogger } from '../shared/logger/index.js';
// ============================================================
// CHAT ORCHESTRATOR
// Brain of the chatbot. Uses an LLM (OpenRouter, Local, etc.)
// to understand intent, manage state, and trigger automation.
// ============================================================
const openai = getOpenAICompatibleClient();
const logger = createLogger('chat-orchestrator');
function normalizeText(value) {
    return value.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function shouldDisableContextMemory(message) {
    return /don't use context memory|do not use context memory|dont use memory|do not use memory|forget context|without memory/i.test(message);
}
function shouldEnableContextMemory(message) {
    return /use context memory|use memory|remember context|use my saved details/i.test(message);
}
function shouldCancelTask(message) {
    return /\b(stop|cancel|pause|end task|abort)\b/i.test(message);
}
function formatWorkflowSummary(workflows) {
    if (!workflows.length)
        return 'No active workflows available.';
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
async function findMatchingWorkflow(task) {
    const normalizedTask = normalizeText(task);
    const workflows = await siteWorkflowService.listAll();
    let best = null;
    for (const workflow of workflows) {
        if (workflow.status !== 'published')
            continue;
        let score = 0;
        const trigger = normalizeText(workflow.trigger);
        const name = normalizeText(workflow.name);
        if (trigger && normalizedTask.includes(trigger))
            score += 10;
        if (name && normalizedTask.includes(name))
            score += 7;
        for (const phrase of workflow.triggerPhrases ?? []) {
            const normalizedPhrase = normalizeText(phrase);
            if (normalizedPhrase && normalizedTask.includes(normalizedPhrase))
                score += 8;
        }
        for (const input of workflow.requiredInputs ?? []) {
            if (normalizedTask.includes(input.replace(/_/g, ' ')))
                score += 1;
        }
        if (!best || score > best.score) {
            best = {
                siteId: workflow.siteId,
                workflowName: workflow.name,
                trigger: workflow.trigger,
                score,
                lightweight: workflow.metadata?.lightweight,
            };
        }
    }
    return best && best.score > 0 ? best : null;
}
function buildManualGuidanceReply(parsed, originalMessage) {
    const steps = parsed.manualGuidance?.steps?.filter(Boolean) ?? [];
    if (!steps.length) {
        return `I don't have direct automation support for this task yet. Could you tell me the website name or the exact task you need help with? I can guide you through the manual steps. 👍`;
    }
    return `${parsed.replyText ?? `Direct automation isn't available for this task yet, but here are the manual steps you can follow. ✅`}\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
}
async function generateManualGuidance(userMessage, workflowSummary, profileSummary) {
    const { chatModel } = getLLMProviderConfig();
    const reasoningBody = getReasoningRequestBody();
    const requestBody = {
        model: chatModel,
        messages: [
            {
                role: 'system',
                content: `You are Agent. The requested task is not supported by any active automation workflow right now.
Give a helpful, accurate, user-facing manual guide for the exact Indian government/job task.
Never mention missing workflows or internal tooling. Always respond in English.
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
        response_format: { type: 'json_object' },
    };
    if (reasoningBody) {
        requestBody.extra_body = reasoningBody;
    }
    const response = await openai.chat.completions.create(requestBody);
    const responseContent = response.choices[0]?.message?.content;
    const content = typeof responseContent === 'string' ? responseContent : '{}';
    const parsed = JSON.parse(content);
    const intro = parsed.replyText ?? 'Here are the steps you can follow to complete this task manually. ✅';
    const steps = parsed.steps?.filter(Boolean) ?? [];
    if (!steps.length)
        return intro;
    return `${intro}\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
}
export class ChatOrchestrator {
    /**
     * Main entry point for a new chat message
     */
    async handleMessage(userId, sessionId, message, replyCallback, jobStartedCallback) {
        const state = await this.getState(userId, sessionId);
        let workflowSummaryForTurn = 'No active workflows available.';
        let profileSummaryForTurn = 'No saved user profiles.';
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
        // (Removed blind input assumption. The LLM will now classify if this is the requested input or a chat question)
        // Classify intent via LLM — always use the real AI provider
        try {
            const { chatModel } = getLLMProviderConfig();
            const reasoningBody = getReasoningRequestBody();
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
            const requestBody = {
                model: chatModel,
                messages: [
                    { role: 'system', content: FORMKARO_SYSTEM_PROMPT },
                    { role: 'system', content: `ACTIVE WORKFLOWS:\n${workflowSummary}\n\nUSER PROFILES:\n${profileSummary}\n\nUSER FILES:\n${fileSummary}\n\nSESSION MEMORY:\n${sessionMemorySummary}` },
                    ...state.history.map(h => ({ role: h.role, content: h.content }))
                ],
                response_format: { type: "json_object" }
            };
            if (reasoningBody) {
                requestBody.extra_body = reasoningBody;
            }
            let response;
            let responseContent = null;
            try {
                response = await openai.chat.completions.create(requestBody, { timeout: 30000 });
                responseContent = response.choices[0]?.message?.content ?? null;
            }
            catch (err) {
                logger.error('llm:chat-orchestration-failed', {
                    userId,
                    sessionId,
                    messagePreview: message.slice(0, 100),
                    errorName: err.name,
                    errorMessage: err.message,
                });
                let errorMsg = "Sorry, I'm experiencing network issues connecting to the AI provider. Please try again in a moment. 🔌";
                if (err.message && err.message.includes('429')) {
                    errorMsg = "The AI provider is currently rate-limited (too many requests). Please wait a minute and try again! ⏳";
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
            let parsed;
            try {
                parsed = JSON.parse(content.trim());
            }
            catch {
                // Model returned plain text instead of JSON — wrap it as a chat reply
                logger.warn('llm:non-json-response', { rawContent: content.slice(0, 200) });
                parsed = { replyText: responseContent ?? "I'm here to help! What would you like to do? 😊", intent: 'chat' };
            }
            if (parsed.memory?.shouldUseContext === false) {
                state.memoryContext.useContextMemory = false;
            }
            else if (parsed.memory?.shouldUseContext === true) {
                state.memoryContext.useContextMemory = true;
            }
            if (parsed.memory?.profileHint) {
                state.memoryContext.lastProfileHint = parsed.memory.profileHint;
            }
            const replyText = parsed.replyText || 'I\'m here to help! What would you like to do? 😊';
            state.history.push({ role: 'assistant', content: replyText });
            replyCallback(replyText);
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
                await memoryService.storeEphemeralData(userId, `job:${state.activeJobId}:input:${state.awaitingInput.stepId}`, message, 900);
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
                    const manualFallback = await generateManualGuidance(message, workflowSummaryForTurn, profileSummaryForTurn);
                    state.history.push({ role: 'assistant', content: manualFallback });
                    replyCallback(manualFallback);
                    await this.saveState(state);
                    return;
                }
                let taskInstruction = parsed.jobDetails.task;
                // Append profile data if requested
                if (parsed.jobDetails.profileToUse) {
                    const profile = await memoryService.getProfileByName(userId, parsed.jobDetails.profileToUse);
                    if (profile) {
                        taskInstruction += `\nUse the following details: ${JSON.stringify(profile.data)}`;
                    }
                    else {
                        replyCallback(`I couldn't find a saved profile named '${parsed.jobDetails.profileToUse}'. I'll try to continue without it. 🙏`);
                    }
                }
                const savedFiles = await fileStorageService.summarizeFiles(userId);
                taskInstruction += `\nAvailable uploaded files for automation:\n${savedFiles}`;
                taskInstruction += `\nMatched workflow: ${workflowMatch.workflowName} (${workflowMatch.siteId})`;
                const job = {
                    id: randomUUID(),
                    type: 'execute',
                    priority: 'normal',
                    createdAt: new Date(),
                    userId,
                    sessionId,
                    payload: {
                        siteId: workflowMatch.siteId,
                        task: taskInstruction,
                        sessionId,
                        useCache: false,
                        lightweight: workflowMatch.lightweight
                    }
                };
                const jobId = await enqueueJob(job);
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
                }
                catch (e) {
                    logger.error('failed-to-get-queue-position', e);
                }
            }
            await this.saveState(state);
        }
        catch (err) {
            logger.error('llm:chat-orchestration-failed', err, { userId, sessionId, messagePreview: message.slice(0, 160) });
            replyCallback("Sorry, I had trouble understanding your request. Could you try rephrasing it? I'm here to help. 🙏");
        }
    }
    /**
     * Called by the Execution engine via Redis pub/sub when a job pauses for OTP/CAPTCHA
     */
    async handleJobPauseRequest(userId, sessionId, jobId, stepId, type, contextMessage, replyCallback) {
        const state = await this.getState(userId, sessionId);
        state.activeJobId = jobId;
        state.awaitingInput = { jobId, stepId, type, contextMessage };
        state.history.push({ role: 'assistant', content: contextMessage });
        await this.saveState(state);
        await this.saveJobRuntimeState({
            jobId,
            userId,
            sessionId,
            siteId: state.memoryContext.siteId ?? 'unknown',
            task: state.memoryContext.task ?? '',
            status: 'paused',
            activeStepId: stepId,
            lastInputType: type,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        replyCallback(contextMessage);
    }
    async resumeJob(jobId, input) {
        const redis = await getRedisClient();
        await redis.publish(`job:resume:${jobId}`, input);
    }
    // ─── State Management ────────────────────────────────────────
    async getState(userId, sessionId) {
        const redis = await getRedisClient();
        const key = `chat-state:${userId}:${sessionId}`;
        const data = await redis.get(key);
        if (data) {
            return JSON.parse(data);
        }
        return {
            userId,
            sessionId,
            history: [],
            memoryContext: {},
            lastUpdated: new Date()
        };
    }
    async saveState(state) {
        const redis = await getRedisClient();
        const key = `chat-state:${state.userId}:${state.sessionId}`;
        state.lastUpdated = new Date();
        await redis.setEx(key, 86400, JSON.stringify(state)); // 24 hour TTL
    }
    async saveJobRuntimeState(state) {
        const redis = await getRedisClient();
        await redis.setEx(CacheKeys.jobRuntime(state.jobId), 86400, JSON.stringify(state));
    }
}
export const chatOrchestrator = new ChatOrchestrator();
//# sourceMappingURL=chat-orchestrator.js.map