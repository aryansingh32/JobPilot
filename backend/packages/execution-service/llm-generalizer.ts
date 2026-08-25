import { getOpenAICompatibleClient, getLLMProviderConfig } from '../shared/llm/index.js';
import { ActionStep } from './recorder.js';

export async function generalizeSteps(steps: ActionStep[], starterActionPlan?: string): Promise<any[]> {
  const client = getOpenAICompatibleClient();
  const config = getLLMProviderConfig();

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
    const response = await client.chat.completions.create({
      model: config.chatModel,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('No response from LLM');

    const result = JSON.parse(content);
    return result.steps || [];
  } catch (err) {
    console.error('Failed to generalize steps via LLM, falling back to mock logic', err);
    // Mock fallback logic
    return steps.map(step => ({
      ...step,
      target: {
        selector: `role=element[name='${step.target?.text || step.target?.selector}']`,
        isUserInput: step.action === 'input' || step.action === 'change'
      }
    }));
  }
}
