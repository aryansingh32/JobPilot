import type { ActionStep } from '../shared/types/index.js';
export interface DryRunResult {
    success: boolean;
    stepsExecuted: number;
    error?: string;
    failedStepId?: string;
    durationMs: number;
}
export declare class DryRunService {
    runDryRun(url: string, steps: ActionStep[]): Promise<DryRunResult>;
}
export declare const dryRunService: DryRunService;
//# sourceMappingURL=dry-run-service.d.ts.map