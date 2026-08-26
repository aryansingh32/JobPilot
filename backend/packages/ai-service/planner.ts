import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import type {
  ActionStep, AIDecision, CachedFlow, DOMSnapshot,
  ExtractedElement, SimplifiedDOM, SiteWorkflow,
} from '../shared/types/index.js';
import { getPgPool, cacheGet, cacheSet, CacheKeys } from '../shared/db/index.js';
import { getLLMProviderConfig, getOpenAICompatibleClient, getReasoningRequestBody } from '../shared/llm/index.js';

// ============================================================
// AI SERVICE
// Uses an OpenAI-compatible LLM provider for:
//   1. Natural language → action plan conversion
//   2. Selector fallback recovery
//   3. Error recovery suggestions
//   4. Flow caching (AI is fallback, not primary path)
// ============================================================

function getTextResponse(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

// ─── Flow Cache ──────────────────────────────────────────────

function hashTask(task: string): string {
  // Normalize: lowercase, trim, remove punctuation
  const normalized = task.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
  return createHash('md5').update(normalized).digest('hex');
}

async function getCachedFlow(siteId: string, task: string): Promise<CachedFlow | null> {
  const taskHash = hashTask(task);
  const cacheKey = CacheKeys.flowCache(siteId, taskHash);

  // Redis fast path
  const cached = await cacheGet<CachedFlow>(cacheKey);
  if (cached) {
    console.log(`[AI] ✅ Cache hit for task "${task.slice(0, 40)}"`);
    return cached;
  }

  // Postgres fallback
  const pool = getPgPool();
  const { rows } = await pool.query(`
    SELECT * FROM cached_flows
    WHERE site_id = $1 AND task_hash = $2
      AND success_count > failure_count    -- only use flows with more wins than losses
    LIMIT 1
  `, [siteId, taskHash]);

  if (rows.length > 0) {
    const flow: CachedFlow = {
      id:           rows[0].id,
      siteId:       rows[0].site_id,
      taskHash:     rows[0].task_hash,
      task:         rows[0].task,
      actionPlan:   rows[0].action_plan,
      successCount: rows[0].success_count,
      failureCount: rows[0].failure_count,
      lastUsed:     rows[0].last_used,
      avgDuration:  rows[0].avg_duration_ms,
    };
    await cacheSet(cacheKey, flow, 1800);
    return flow;
  }

  return null;
}

async function saveFlow(siteId: string, task: string, actionPlan: ActionStep[]): Promise<void> {
  const taskHash = hashTask(task);
  const pool = getPgPool();

  await pool.query(`
    INSERT INTO cached_flows (site_id, task_hash, task, action_plan, success_count)
    VALUES ($1, $2, $3, $4, 1)
    ON CONFLICT (site_id, task_hash) DO UPDATE SET
      action_plan   = EXCLUDED.action_plan,
      success_count = cached_flows.success_count + 1,
      last_used     = NOW()
  `, [siteId, taskHash, task, JSON.stringify(actionPlan)]);

  const cacheKey = CacheKeys.flowCache(siteId, taskHash);
  await cacheSet(cacheKey, { siteId, taskHash, task, actionPlan }, 1800);
}

async function markFlowFailure(siteId: string, task: string): Promise<void> {
  const taskHash = hashTask(task);
  await getPgPool().query(`
    UPDATE cached_flows
    SET failure_count = failure_count + 1
    WHERE site_id = $1 AND task_hash = $2
  `, [siteId, taskHash]);
}

async function getSiteWorkflowContext(siteId: string): Promise<string> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT
       workflow_key,
       category,
       name,
       trigger,
       trigger_phrases,
       portal_type,
       site_section,
       entry_url,
       page_url,
       page_url_pattern,
       page_url_patterns,
       required_inputs,
       instructions,
       default_profile_name,
       starter_action_plan,
       error_recovery_plan,
       metadata
     FROM site_workflows
     WHERE site_id = $1
       AND is_active = true
     ORDER BY updated_at DESC, name ASC
     LIMIT 10`,
    [siteId]
  );

  if (!rows.length) return 'No custom site workflow instructions are configured.';

  return rows.map((row, index) => JSON.stringify({
    priority: index + 1,
    name: row.name,
    workflowKey: row.workflow_key,
    category: row.category,
    trigger: row.trigger,
    triggerPhrases: row.trigger_phrases ?? [],
    portalType: row.portal_type,
    siteSection: row.site_section,
    entryUrl: row.entry_url,
    pageUrl: row.page_url,
    pageUrlPattern: row.page_url_pattern,
    pageUrlPatterns: row.page_url_patterns ?? [],
    requiredInputs: row.required_inputs ?? [],
    instructions: row.instructions,
    defaultProfileName: row.default_profile_name,
    starterActionPlan: row.starter_action_plan ?? [],
    errorRecoveryPlan: row.error_recovery_plan ?? [],
    metadata: row.metadata ?? {},
  })).join('\n');
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreWorkflowMatch(workflow: SiteWorkflow, task: string, pageUrl?: string): number {
  const normalizedTask = normalizeText(task);
  let score = 0;

  const trigger = normalizeText(workflow.trigger);
  const name = normalizeText(workflow.name);
  const section = normalizeText(workflow.siteSection ?? '');
  const category = normalizeText(workflow.category ?? '');
  const triggerPhrases = workflow.triggerPhrases ?? [];

  if (trigger && normalizedTask.includes(trigger)) score += 10;
  if (name && normalizedTask.includes(name)) score += 6;
  if (section && normalizedTask.includes(section)) score += 4;
  if (category && normalizedTask.includes(category)) score += 3;
  for (const phrase of triggerPhrases) {
    const normalizedPhrase = normalizeText(phrase);
    if (normalizedPhrase && normalizedTask.includes(normalizedPhrase)) score += 8;
  }

  if (workflow.requiredInputs?.length) {
    for (const input of workflow.requiredInputs) {
      if (normalizedTask.includes(input.replace('_', ' '))) score += 1;
    }
  }

  if (pageUrl && workflow.pageUrl && pageUrl === workflow.pageUrl) score += 12;
  if (pageUrl && workflow.pageUrlPattern) {
    try {
      if (new RegExp(workflow.pageUrlPattern).test(pageUrl)) score += 8;
    } catch {
      if (pageUrl.includes(workflow.pageUrlPattern)) score += 4;
    }
  }
  for (const pattern of workflow.pageUrlPatterns ?? []) {
    try {
      if (pageUrl && new RegExp(pattern).test(pageUrl)) score += 8;
    } catch {
      if (pageUrl && pageUrl.includes(pattern)) score += 4;
    }
  }

  if (workflow.starterActionPlan?.length) score += 5;
  return score;
}

async function getStructuredWorkflows(siteId: string): Promise<SiteWorkflow[]> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT
       id,
       workflow_key as "workflowKey",
       site_id as "siteId",
       category,
       name,
       trigger,
       trigger_phrases as "triggerPhrases",
       portal_type as "portalType",
       site_section as "siteSection",
       entry_url as "entryUrl",
       page_url as "pageUrl",
       page_url_pattern as "pageUrlPattern",
       page_url_patterns as "pageUrlPatterns",
       required_inputs as "requiredInputs",
       required_files as "requiredFiles",
       instructions,
       default_profile_name as "defaultProfileName",
       starter_action_plan as "starterActionPlan",
       error_recovery_plan as "errorRecoveryPlan",
       version,
       is_active as "isActive",
       completion_artifact as "completionArtifact",
       metadata,
       created_at as "createdAt",
       updated_at as "updatedAt"
     FROM site_workflows
     WHERE site_id = $1
       AND is_active = true
     ORDER BY updated_at DESC, name ASC`,
    [siteId]
  );

  return rows;
}

async function findBestStructuredWorkflow(
  siteId: string,
  task: string,
  pageUrl?: string
): Promise<{ workflow: SiteWorkflow; score: number } | null> {
  const workflows = await getStructuredWorkflows(siteId);
  if (!workflows.length) return null;

  const ranked = workflows
    .map((workflow) => ({ workflow, score: scoreWorkflowMatch(workflow, task, pageUrl) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0] ?? null;
}

// ─── DOM Serializer ──────────────────────────────────────────

function serializeDOM(snapshot: DOMSnapshot, elements: ExtractedElement[]): string {
  const interactable = elements
    .filter((e) => e.interactable)
    .slice(0, 80)   // cap for token budget
    .map((e) => ({
      type: e.type,
      label: e.label,
      selector: e.selectors[0]?.value ?? 'unknown',
      visible: e.visible,
    }));

  return JSON.stringify({ url: snapshot.url, elements: interactable }, null, 2);
}

export function buildSyntheticSnapshot(url?: string): DOMSnapshot {
  return {
    url: url ?? 'about:blank',
    timestamp: new Date(),
    html: '',
    simplified: [],
  };
}

// ─── Action Plan Generator ────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert browser automation planner.
Given a website's interactive elements and a user task, generate a precise JSON action plan.

RULES:
1. Return ONLY valid JSON — no markdown, no explanation
2. Each step must have a unique id (use short random strings like "s1", "s2")
3. action must be one of: navigate, click, fill, select, check, uncheck, upload, download, waitForSelector, waitForNavigation, waitForTimeout, scroll, mouseMove, humanType, screenshot, extractData, pauseForUserInput, runSubWorkflow, conditional, customJS, refresh, payment
4. timeout is in milliseconds (default 10000)
5. retries should be 2 for critical steps, 1 for others
6. For fill actions, value is the text to type
7. For navigate, value is the full URL
8. target.value is a selector or lookup value, and target.type should be one of css, text, role, testid, xpath, or url
9. description must be human-readable (used as label for AI selector fallback)
10. Keep plans minimal — only necessary steps
11. If login, signup, OTP, CAPTCHA, payment, email, mobile, or password input is required and the task does not contain it, insert pauseForUserInput before the dependent step.
12. For pauseForUserInput, set expectedInput to otp, upi_id, captcha, confirmation, text, email, mobile, or password.
13. If payment is required, prefer a payment step followed by a confirmation pause.
14. If a workflow defines requiredInputs, make sure the plan either uses them directly or pauses to collect them.
15. If a workflow includes starterActionPlan, treat it as high-priority guidance for matching tasks.

OUTPUT FORMAT:
{
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "warnings": ["any caveats"],
  "estimatedDuration": milliseconds,
  "actionPlan": [
    {
      "id": "s1",
      "order": 1,
      "action": "navigate",
      "value": "https://example.com/login",
      "target": null,
      "waitFor": null,
      "timeout": 10000,
      "retries": 1,
      "description": "Navigate to login page"
    }
  ]
}`;

// ─── AI Planner ───────────────────────────────────────────────

export class AIPlanner {

  async planTask(
    task: string,
    siteId: string,
    snapshot: DOMSnapshot,
    elements: ExtractedElement[],
    useCache = true
  ): Promise<AIDecision> {
    // Structured workflow match first — primary mode
    const matchedWorkflow = await findBestStructuredWorkflow(siteId, task, snapshot.url);
    if (matchedWorkflow?.workflow.starterActionPlan?.length) {
      return {
        confidence: 0.98,
        reasoning: `Matched structured workflow "${matchedWorkflow.workflow.name}"`,
        actionPlan: matchedWorkflow.workflow.starterActionPlan,
        estimatedDuration: matchedWorkflow.workflow.starterActionPlan.length * 3000,
        warnings: [],
        fallbackPlan: matchedWorkflow.workflow.errorRecoveryPlan,
        source: 'structured-workflow',
        matchedWorkflowId: matchedWorkflow.workflow.id,
        matchedWorkflowName: matchedWorkflow.workflow.name,
      };
    }

    // Check cache second — still cheaper than AI
    if (useCache) {
      const cached = await getCachedFlow(siteId, task);
      if (cached) {
        return {
          confidence: 0.9,
          reasoning: `Replaying cached flow (${cached.successCount} successes, ${cached.failureCount} failures)`,
          actionPlan: cached.actionPlan,
          estimatedDuration: cached.avgDuration,
          warnings: [],
          source: 'cached-flow',
        };
      }
    }

    console.log(`[AI] Planning task: "${task.slice(0, 60)}"`);
    const domContext = serializeDOM(snapshot, elements);
    const workflowContext = await getSiteWorkflowContext(siteId);
    const client = getOpenAICompatibleClient();
    const { plannerModel } = getLLMProviderConfig();
    const reasoningBody = getReasoningRequestBody();

    const requestBody: Record<string, unknown> = {
      model: plannerModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `TASK: ${task}\n\nSITE WORKFLOW INSTRUCTIONS:\n${workflowContext}\n\nPAGE STATE:\n${domContext}`,
        },
      ],
    };
    if (reasoningBody) {
      requestBody.extra_body = reasoningBody;
    }

    const response = await client.chat.completions.create(requestBody as any);
    const raw = getTextResponse(response.choices[0]?.message?.content);

    let parsed: AIDecision;
    try {
      // Strip potential markdown fences
      const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
      const data = JSON.parse(clean);
      parsed = {
        confidence:        data.confidence ?? 0.7,
        reasoning:         data.reasoning ?? '',
        actionPlan:        data.actionPlan ?? [],
        estimatedDuration: data.estimatedDuration ?? 5000,
        warnings:          data.warnings ?? [],
        fallbackPlan:      data.fallbackPlan,
        source:            'ai-generated',
        matchedWorkflowId: matchedWorkflow?.workflow.id,
        matchedWorkflowName: matchedWorkflow?.workflow.name,
      };
    } catch (err) {
      throw new Error(`[AI] Failed to parse action plan: ${(err as Error).message}\nRaw: ${raw.slice(0, 200)}`);
    }

    // Cache the new flow
    if (parsed.actionPlan.length > 0) {
      await saveFlow(siteId, task, parsed.actionPlan);
    }

    return parsed;
  }

  // ─── Error Recovery ───────────────────────────────────────────

  async recoverFromFailure(
    originalTask: string,
    failedStep: ActionStep,
    errorMessage: string,
    currentDOM: string
  ): Promise<ActionStep[] | null> {
    console.log(`[AI] Attempting recovery for failed step: ${failedStep.description}`);
    const client = getOpenAICompatibleClient();
    const { recoveryModel } = getLLMProviderConfig();

    // No reasoning trace here — this is bounded structured-JSON generation,
    // not multi-step reasoning, so skip the extra latency/cost.
    const requestBody: Record<string, unknown> = {
      model: recoveryModel,
      messages: [
        {
          role: 'user',
          content: `A browser automation step failed. Suggest recovery steps.

ORIGINAL TASK: ${originalTask}
FAILED STEP: ${JSON.stringify(failedStep)}
ERROR: ${errorMessage}
CURRENT DOM (simplified): ${currentDOM.slice(0, 2000)}

Return a JSON array of recovery ActionStep objects, or null if unrecoverable.
Format: { "recoverable": true/false, "steps": [...] }`,
        },
      ],
    };

    const response = await client.chat.completions.create(requestBody as any);
    const raw = getTextResponse(response.choices[0]?.message?.content);
    try {
      const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
      const data = JSON.parse(clean);
      return data.recoverable ? data.steps : null;
    } catch {
      return null;
    }
  }

  // ─── AI Selector Recovery ─────────────────────────────────────
  // Used as stage-4 fallback in SelectorEngine

  async resolveSelector(
    page: import('playwright').Page,
    label: string,
    elementType: string,
    bodyContext?: string
  ): Promise<string | null> {
    const client = getOpenAICompatibleClient();
    const { selectorModel } = getLLMProviderConfig();
    // No reasoning trace — this is a one-shot element-matching classification,
    // not multi-step reasoning, so skip the extra latency/cost.
    const requestBody: Record<string, unknown> = {
      model: selectorModel,
      messages: [
        {
          role: 'user',
          content: `Given this page content, return a CSS selector for element:
Label: "${label}"
Type: ${elementType}

PAGE TEXT (first 1500 chars):
${(bodyContext ?? '').slice(0, 1500)}

Return ONLY a CSS selector string, no explanation. If impossible, return null.`,
        },
      ],
    };

    const response = await client.chat.completions.create(requestBody as any);
    const raw = getTextResponse(response.choices[0]?.message?.content).trim();
    if (!raw || raw === 'null' || raw.length > 200) return null;

    // Validate the selector works
    try {
      const count = await page.locator(raw).count();
      return count > 0 ? raw : null;
    } catch {
      return null;
    }
  }

  // ─── Flow Feedback ────────────────────────────────────────────

  async recordOutcome(siteId: string, task: string, success: boolean): Promise<void> {
    if (!success) {
      await markFlowFailure(siteId, task);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────

let aiPlanner: AIPlanner | null = null;
export function getAIPlanner(): AIPlanner {
  if (!aiPlanner) aiPlanner = new AIPlanner();
  return aiPlanner;
}
