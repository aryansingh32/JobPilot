import type { ActionStep } from './recorder.js';
import { compileRecording } from '../shared/workflows/compile-recording.js';

/** Compatibility endpoint: recorded interactions already describe the plan.
 * Compile locally into the executor contract rather than asking a model to
 * invent selectors or sending recorded personal data to a provider.
 * Semantic planning/recovery remains in AIPlanner, with validated output.
 */
export async function generalizeSteps(steps: ActionStep[], _starterActionPlan?: string) {
  return compileRecording(steps);
}
