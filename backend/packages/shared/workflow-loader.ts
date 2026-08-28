import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPgPool, runMigrations } from './db/index.js';
import type { ActionStep, SiteWorkflow } from './types/index.js';

type WorkflowDefinition = {
  id: string;
  siteId?: string;
  category?: string;
  name: string;
  trigger?: string;
  triggerPhrases?: string[];
  entryUrl: string;
  pageUrl?: string;
  pageUrlPattern?: string;
  pageUrlPatterns?: string[];
  requiredInputs?: string[];
  requiredFiles?: Array<'resume' | 'signature' | 'photo' | 'document' | 'receipt' | 'other'>;
  defaultProfile?: string;
  defaultProfileName?: string;
  starterActionPlan: ActionStep[];
  errorRecoveryPlan?: ActionStep[];
  instructions?: string;
  completionArtifact?: string;
  version?: number;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
  portalType?: SiteWorkflow['portalType'];
  siteSection?: string;
};

type NormalizedWorkflow = WorkflowDefinition & {
  trigger: string;
  triggerPhrases: string[];
  pageUrlPatterns: string[];
  defaultProfileName: string;
  instructions: string;
  version: number;
  isActive: boolean;
  siteId: string;
};

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function defaultWorkflowDirectory(): string {
  return path.resolve(process.cwd(), 'workflows');
}

function sortSteps(steps: ActionStep[] | undefined): ActionStep[] {
  return [...(steps ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function normalizeStep(step: ActionStep, index: number): ActionStep {
  return {
    ...step,
    order: step.order ?? index + 1,
    timeout: step.timeout ?? 10_000,
    retries: step.retries ?? 1,
    description: step.description ?? `${step.action} step ${step.id}`,
    humanDelay: step.humanDelay ?? false,
    humanType: step.humanType ?? false,
    trueSteps: sortSteps(step.trueSteps).map(normalizeStep),
    falseSteps: sortSteps(step.falseSteps).map(normalizeStep),
  };
}

function normalizeWorkflow(workflow: WorkflowDefinition): NormalizedWorkflow {
  if (!workflow.id?.trim()) throw new Error('Workflow id is required');
  if (!workflow.name?.trim()) throw new Error('Workflow name is required');
  if (!workflow.entryUrl?.trim()) throw new Error('Workflow entryUrl is required');
  if (!workflow.starterActionPlan?.length) throw new Error('starterActionPlan is required');

  const triggerPhrases = Array.from(
    new Set(
      (workflow.triggerPhrases?.length ? workflow.triggerPhrases : [workflow.trigger ?? workflow.name])
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );

  const pageUrlPatterns = Array.from(
    new Set(
      (workflow.pageUrlPatterns?.length ? workflow.pageUrlPatterns : workflow.pageUrlPattern ? [workflow.pageUrlPattern] : [])
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );

  return {
    ...workflow,
    siteId: workflow.siteId?.trim() || new URL(workflow.entryUrl).hostname,
    trigger: workflow.trigger?.trim() || triggerPhrases[0],
    triggerPhrases,
    pageUrlPatterns,
    defaultProfileName: workflow.defaultProfileName?.trim() || workflow.defaultProfile?.trim() || 'default',
    instructions: workflow.instructions?.trim() || workflow.name.trim(),
    version: workflow.version ?? 1,
    isActive: workflow.isActive !== false,
    starterActionPlan: sortSteps(workflow.starterActionPlan).map(normalizeStep),
    errorRecoveryPlan: sortSteps(workflow.errorRecoveryPlan).map(normalizeStep),
  };
}

export class WorkflowLoader {
  constructor(private readonly workflowsDir = defaultWorkflowDirectory()) {}

  async loadAllWorkflows(): Promise<{ loaded: number; skipped: number; files: string[] }> {
    console.log(`[WorkflowLoader] Starting workflow sync from ${this.workflowsDir}`);
    const files = await this.getAllWorkflowFiles();
    const pool = getPgPool();
    let loaded = 0;
    let skipped = 0;

    for (const file of files) {
      try {
        const raw = await fs.readFile(file, 'utf8');
        const workflow = normalizeWorkflow(JSON.parse(raw) as WorkflowDefinition);
        const siteUuid = await this.ensureSite(workflow);

        await pool.query(
          `INSERT INTO site_workflows (
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
             completion_artifact,
             metadata,
             status,
             created_at,
             updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, NOW(), NOW()
           )
           ON CONFLICT (workflow_key)
           DO UPDATE SET
             site_id = EXCLUDED.site_id,
             category = EXCLUDED.category,
             name = EXCLUDED.name,
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
             completion_artifact = EXCLUDED.completion_artifact,
             metadata = EXCLUDED.metadata,
             status = EXCLUDED.status,
             updated_at = NOW()`,
          [
            workflow.id,
            siteUuid,
            workflow.category ?? 'general',
            workflow.name,
            workflow.trigger,
            workflow.triggerPhrases,
            workflow.portalType ?? null,
            workflow.siteSection ?? null,
            workflow.entryUrl,
            workflow.pageUrl ?? null,
            workflow.pageUrlPattern ?? workflow.pageUrlPatterns[0] ?? null,
            workflow.pageUrlPatterns,
            workflow.requiredInputs ?? [],
            workflow.requiredFiles ?? [],
            workflow.instructions,
            workflow.defaultProfileName,
            JSON.stringify(workflow.starterActionPlan),
            JSON.stringify(workflow.errorRecoveryPlan ?? []),
            workflow.version,
            workflow.isActive,
            workflow.completionArtifact ?? null,
            JSON.stringify(workflow.metadata ?? {}),
            workflow.isActive ? 'published' : 'draft',
          ]
        );

        loaded++;
        console.log(`[WorkflowLoader] Loaded ${workflow.id} from ${path.relative(process.cwd(), file)}`);
      } catch (error) {
        skipped++;
        console.error(`[WorkflowLoader] Failed to load ${file}:`, error);
      }
    }

    console.log(`[WorkflowLoader] Sync complete. loaded=${loaded} skipped=${skipped}`);
    return { loaded, skipped, files };
  }

  private async getAllWorkflowFiles(): Promise<string[]> {
    const files: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'site.json') {
          // site.json is a per-category manifest (name/domain/workflow list), not a
          // workflow definition — every category directory has one, and it will
          // never satisfy normalizeWorkflow's required fields.
          files.push(fullPath);
        }
      }
    };

    try {
      await walk(this.workflowsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`[WorkflowLoader] Directory not found: ${this.workflowsDir}`);
        return [];
      }
      throw error;
    }

    return files.sort();
  }

  private async ensureSite(workflow: NormalizedWorkflow): Promise<string> {
    const pool = getPgPool();
    const domain = new URL(workflow.entryUrl).hostname;
    const { rows } = await pool.query(
      `INSERT INTO sites (domain, config, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (domain)
       DO UPDATE SET
         config = COALESCE(sites.config, '{}'::jsonb) || EXCLUDED.config,
         updated_at = NOW()
       RETURNING id`,
      [
        domain,
        JSON.stringify({
          source: 'workflow-loader',
          workflowSiteId: workflow.siteId,
          category: workflow.category ?? 'general',
        }),
      ]
    );

    return rows[0].id as string;
  }
}

export const workflowLoader = new WorkflowLoader();

if (isMainModule()) {
  runMigrations()
    .then(() => workflowLoader.loadAllWorkflows())
    .catch((error) => {
    console.error('[WorkflowLoader] Fatal error:', error);
    process.exit(1);
    });
}
