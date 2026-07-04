import { getPgPool, cacheGet, cacheSet, cacheDelete } from '../shared/db/index.js';
const WORKFLOW_SELECT = `SELECT
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
  status,
  completion_artifact as "completionArtifact",
  metadata,
  created_at as "createdAt",
  updated_at as "updatedAt"
FROM site_workflows`;
export class SiteWorkflowService {
    async summarizeForSite(siteId) {
        const workflows = await this.listForSite(siteId);
        if (!workflows.length)
            return 'No saved site workflows.';
        return workflows.slice(0, 20).map((workflow) => JSON.stringify({
            name: workflow.name,
            workflowKey: workflow.workflowKey ?? null,
            category: workflow.category ?? null,
            trigger: workflow.trigger,
            triggerPhrases: workflow.triggerPhrases ?? [],
            portalType: workflow.portalType ?? null,
            siteSection: workflow.siteSection ?? null,
            entryUrl: workflow.entryUrl ?? null,
            pageUrl: workflow.pageUrl ?? null,
            pageUrlPattern: workflow.pageUrlPattern ?? null,
            pageUrlPatterns: workflow.pageUrlPatterns ?? [],
            requiredInputs: workflow.requiredInputs ?? [],
            requiredFiles: workflow.requiredFiles ?? [],
            defaultProfileName: workflow.defaultProfileName ?? null,
            version: workflow.version ?? 1,
            isActive: workflow.isActive ?? true,
            completionArtifact: workflow.completionArtifact ?? null,
            metadata: workflow.metadata ?? {},
        })).join('\n');
    }
    async getWorkflow(workflowId) {
        const pool = getPgPool();
        const { rows } = await pool.query(`${WORKFLOW_SELECT}
       WHERE id = $1
       LIMIT 1`, [workflowId]);
        return rows[0] ?? null;
    }
    async listAll() {
        const cacheKey = 'workflows:all';
        const cached = await cacheGet(cacheKey);
        if (cached)
            return cached;
        const pool = getPgPool();
        const { rows } = await pool.query(`${WORKFLOW_SELECT}
       ORDER BY updated_at DESC, name ASC`);
        await cacheSet(cacheKey, rows, 300); // 5 mins
        return rows;
    }
    async listForSite(siteId) {
        const cacheKey = `workflows:site:${siteId}`;
        const cached = await cacheGet(cacheKey);
        if (cached)
            return cached;
        const pool = getPgPool();
        const { rows } = await pool.query(`${WORKFLOW_SELECT}
       WHERE site_id = $1
       ORDER BY updated_at DESC, name ASC`, [siteId]);
        await cacheSet(cacheKey, rows, 300); // 5 mins
        return rows;
    }
    async saveWorkflow(input) {
        const pool = getPgPool();
        const workflowKey = input.workflowKey?.trim() || `${input.siteId}:${input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const { rows } = await pool.query(`INSERT INTO site_workflows (
         workflow_key,
         site_id,
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
         required_files,
         instructions,
         default_profile_name,
         starter_action_plan,
         error_recovery_plan,
         version,
         is_active,
         status,
         completion_artifact,
         metadata,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, NOW(), NOW())
       ON CONFLICT (workflow_key)
       DO UPDATE SET
         workflow_key = EXCLUDED.workflow_key,
         category = EXCLUDED.category,
         trigger = EXCLUDED.trigger,
         trigger_phrases = EXCLUDED.trigger_phrases,
         portal_type = EXCLUDED.portal_type,
         site_section = EXCLUDED.site_section,
         entry_url = EXCLUDED.entry_url,
         page_url = EXCLUDED.page_url,
         page_url_pattern = EXCLUDED.page_url_pattern,
         page_url_patterns = EXCLUDED.page_url_patterns,
         required_inputs = EXCLUDED.required_inputs,
         required_files = EXCLUDED.required_files,
         instructions = EXCLUDED.instructions,
         default_profile_name = EXCLUDED.default_profile_name,
         starter_action_plan = EXCLUDED.starter_action_plan,
         error_recovery_plan = EXCLUDED.error_recovery_plan,
         version = EXCLUDED.version,
         is_active = EXCLUDED.is_active,
         status = EXCLUDED.status,
         status,
         completion_artifact = EXCLUDED.completion_artifact,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING
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
  status,
         completion_artifact as "completionArtifact",
         metadata,
         created_at as "createdAt",
         updated_at as "updatedAt"`, [
            workflowKey,
            input.siteId,
            input.category ?? input.portalType ?? 'general',
            input.name.trim(),
            input.trigger.trim(),
            input.triggerPhrases?.length ? input.triggerPhrases : [input.trigger.trim()],
            input.portalType ?? null,
            input.siteSection?.trim() || null,
            input.entryUrl?.trim() || null,
            input.pageUrl?.trim() || null,
            input.pageUrlPattern?.trim() || null,
            input.pageUrlPatterns?.length ? input.pageUrlPatterns : (input.pageUrlPattern ? [input.pageUrlPattern.trim()] : []),
            input.requiredInputs ?? [],
            input.requiredFiles ?? [],
            input.instructions.trim(),
            input.defaultProfileName?.trim() || null,
            JSON.stringify(input.starterActionPlan ?? []),
            JSON.stringify(input.errorRecoveryPlan ?? []),
            input.version ?? 1,
            input.isActive ?? true,
            input.completionArtifact?.trim() || null,
            JSON.stringify(input.metadata ?? {}),
            input.status ?? 'draft',
        ]);
        await cacheDelete('workflows:all');
        await cacheDelete(`workflows:site:${input.siteId}`);
        return rows[0];
    }
    async deleteWorkflow(workflowId) {
        const pool = getPgPool();
        const { rows } = await pool.query(`DELETE FROM site_workflows WHERE id = $1 RETURNING site_id`, [workflowId]);
        if (rows.length > 0) {
            await cacheDelete('workflows:all');
            await cacheDelete(`workflows:site:${rows[0].site_id}`);
            return true;
        }
        return false;
    }
}
export const siteWorkflowService = new SiteWorkflowService();
//# sourceMappingURL=site-workflow.service.js.map