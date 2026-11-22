import type { ActionStep } from '../shared/types/index.js';
const ACTIONS = new Set(['navigate','click','fill','select','check','uncheck','upload','download','waitForSelector','waitForNavigation','waitForTimeout','scroll','mouseMove','humanType','screenshot','extractData','pauseForUserInput','runSubWorkflow','conditional','refresh','payment','pressKey','doubleClick','hover','rightClick','clearField','switchTab','closeTab','acceptDialog','dismissDialog','assertText','assertURL','iframe','goBack','goForward','credentialFill','paymentGateway','wait','extract']);
const TARGETED = new Set(['click','fill','select','check','uncheck','upload','humanType','doubleClick','hover','rightClick','clearField','assertText']);
/** Model output is untrusted data, even when JSON parsing succeeds. */
export function validateAIPlan(value: unknown): ActionStep[] {
  const ids = new Set<string>(); let count = 0;
  function visit(input: unknown, depth: number): ActionStep[] {
    if (!Array.isArray(input) || !input.length || input.length > 100 || depth > 5) throw new Error('AI plan must contain 1–100 steps with nesting at most 5');
    return input.map((raw, index) => {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid AI step');
      const s = raw as ActionStep;
      if (++count > 300 || typeof s.id !== 'string' || !s.id || ids.has(s.id)) throw new Error('AI step IDs must be unique; maximum 300 steps');
      ids.add(s.id);
      if (!ACTIONS.has(s.action)) throw new Error(`Unsupported AI action: ${s.action}`);
      if (TARGETED.has(s.action) && (typeof s.target?.value !== 'string' || !s.target.value.trim())) throw new Error(`Missing target for ${s.action}`);
      if (s.target?.type && !['css','text','role','testid','xpath','url'].includes(s.target.type)) throw new Error('Invalid target type');
      if (s.value !== undefined && typeof s.value !== 'string') throw new Error('Step value must be a string');
      if (s.action === 'navigate' && !/^https?:\/\/|^\{\{[\w:]+\}\}$/.test(s.value ?? s.target?.value ?? '')) throw new Error('Navigation requires an HTTP(S) URL or runtime binding');
      if (s.timeout !== undefined && (!Number.isFinite(s.timeout) || s.timeout < 1 || s.timeout > 600000)) throw new Error('Invalid step timeout');
      return { ...s, order: index + 1, retries: 0,
        ...(s.trueSteps?.length ? { trueSteps: visit(s.trueSteps, depth + 1) } : {}),
        ...(s.falseSteps?.length ? { falseSteps: visit(s.falseSteps, depth + 1) } : {}),
      };
    });
  }
  return visit(value, 0);
}
