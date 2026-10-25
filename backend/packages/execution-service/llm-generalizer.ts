import { completeJSON } from '../shared/llm/gateway.js';
import type { ActionStep } from './recorder.js';
import { compileRecording } from '../shared/workflows/compile-recording.js';

export async function generalizeSteps(steps: ActionStep[], starterActionPlan?: string): Promise<any[]> {
  const prompt = `You are an AI trained to analyze raw web recording steps and generalize them into robust resilient steps.
The raw steps contain absolute selectors or basic CSS classes.
Your goal is to generalize these to better selectors (like Playwright roles, testids, or descriptive text matches) and identify if a field is a user input field.
${starterActionPlan ? `\nThe admin recording this workflow provided this additional context about what the flow is for and how it should be interpreted — use it to disambiguate ambiguous steps:\n${starterActionPlan}\n` : ''}
Raw steps:
${JSON.stringify(steps, null, 2)}

Respond with a JSON object containing a 'steps' array of generalized steps, keeping the same length, where each step has:
- action: (same as original)
- target: { selector: "generalized selector, e.g. text='Submit' or role=button[name='Submit']", isUserInput: boolean }
- value: (same as original, if any)
- timestamp: (same as original)
`;

  try {
    // Admin tool (recording → workflow); uses the planner model.
    const { data } = await completeJSON<{ steps?: any[] }>({
      purpose: 'planner',
      maxTokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    return data.steps || [];
  } catch (err) {
    // No AI available (or it failed): the deterministic compiler is the fallback.
    console.warn('Generalize via LLM failed, using the deterministic compiler', (err as Error).message);
    return compileRecording(steps);
  }
}
