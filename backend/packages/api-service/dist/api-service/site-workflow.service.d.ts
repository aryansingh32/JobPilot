import type { ActionStep, SiteWorkflow } from '../shared/types/index.js';
export declare class SiteWorkflowService {
    summarizeForSite(siteId: string): Promise<string>;
    getWorkflow(workflowId: string): Promise<SiteWorkflow | null>;
    listAll(): Promise<SiteWorkflow[]>;
    listForSite(siteId: string): Promise<SiteWorkflow[]>;
    saveWorkflow(input: {
        workflowKey?: string;
        siteId: string;
        category?: string;
        name: string;
        trigger: string;
        triggerPhrases?: string[];
        portalType?: 'government' | 'jobs' | 'education' | 'banking' | 'general' | 'aadhaar';
        siteSection?: string;
        entryUrl?: string;
        pageUrl?: string;
        pageUrlPattern?: string;
        pageUrlPatterns?: string[];
        requiredInputs?: string[];
        requiredFiles?: Array<'resume' | 'signature' | 'photo' | 'document' | 'receipt' | 'other'>;
        instructions: string;
        defaultProfileName?: string;
        starterActionPlan?: ActionStep[];
        errorRecoveryPlan?: ActionStep[];
        version?: number;
        isActive?: boolean;
        status?: 'draft' | 'published' | 'archived';
        completionArtifact?: string;
        metadata?: Record<string, unknown>;
    }): Promise<SiteWorkflow>;
    deleteWorkflow(workflowId: string): Promise<boolean>;
}
export declare const siteWorkflowService: SiteWorkflowService;
//# sourceMappingURL=site-workflow.service.d.ts.map