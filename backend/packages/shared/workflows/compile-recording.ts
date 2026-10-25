import type { ActionStep } from '../types/index.js';

// ============================================================
// RECORDING → WORKFLOW — deterministic, no AI.
// Collapses the raw event stream into executor steps: keeps the last value
// per field, drops clicks that only focused a field, turns typed values that
// match the recorder's test profile into {{profile:*}} tokens, file picks into
// the user's resume, and redacted secrets into "ask the user" pauses.
// ============================================================

interface RawStep {
  action: string;
  target?: { selectors?: string[]; text?: string; tag?: string; label?: string; metadata?: { type?: string; name?: string } };
  value?: string;
  url?: string;
  timestamp?: number;
}

export interface CompileOptions {
  /** Flattened test profile (see buildAnswerBook): value → token key. */
  profileValues?: Record<string, string>;
  /** Treat the first navigate as the job's apply URL ({{job:applyUrl}}). */
  jobApply?: boolean;
}

const sameField = (a?: RawStep['target'], b?: RawStep['target']) =>
  !!a?.selectors?.[0] && a.selectors[0] === b?.selectors?.[0];

function toTarget(t: RawStep['target']): ActionStep['target'] {
  const [first, ...rest] = (t?.selectors ?? []).filter(Boolean);
  if (first) return { value: first, type: 'css', fallbackSelectors: rest };
  return { value: t?.text ?? '', type: 'text' };
}

/** '[REDACTED:aadhaar]' → the input card the executor asks with. */
function redactedKind(value: string, type?: string): ActionStep['expectedInput'] {
  const kind = value.match(/^\[REDACTED:(\w+)\]/)?.[1];
  if (kind === 'aadhaar') return 'aadhaar';
  if (kind === 'otp') return 'otp';
  if (kind === 'captcha') return 'captcha';
  if (kind === 'pin') return 'credentialFill';
  return kind === 'password' || type === 'password' ? 'password' : 'text';
}

export function compileRecording(raw: RawStep[], opts: CompileOptions = {}): ActionStep[] {
  const byValue = new Map<string, string>();
  for (const [key, value] of Object.entries(opts.profileValues ?? {})) {
    if (value && value.length > 1 && !byValue.has(value.trim().toLowerCase())) byValue.set(value.trim().toLowerCase(), key);
  }

  // 1. Last value wins per field; consecutive duplicate clicks collapse.
  const events: RawStep[] = [];
  for (const ev of raw) {
    if (ev.action === 'input') ev.action = 'fill';
    if (!['navigate', 'click', 'fill', 'select', 'upload', 'change', 'captcha'].includes(ev.action)) continue;
    if (ev.action === 'change') ev.action = 'fill';
    const prev = events.at(-1);
    if (prev && (ev.action === 'fill' || ev.action === 'select') && prev.action === ev.action && sameField(prev.target, ev.target)) {
      events[events.length - 1] = ev;
      continue;
    }
    if (prev && ev.action === 'click' && prev.action === 'click' && sameField(prev.target, ev.target)) continue;
    // A navigate right after a click is that click's result, not a step.
    if (ev.action === 'navigate' && prev?.action === 'click' && events.length > 1) continue;
    events.push(ev);
  }
  // 2. Drop clicks that only focused / labelled the next field.
  const kept = events.filter((ev, i) => {
    if (ev.action !== 'click') return true;
    const next = events[i + 1];
    if (!next || !['fill', 'select', 'upload'].includes(next.action)) return true;
    const isLabelish = ev.target?.tag === 'label' || ev.target?.tag === 'div' || ev.target?.tag === 'span';
    return !(isLabelish || sameField(ev.target, next.target));
  });

  // 3. Emit executor steps.
  const steps: ActionStep[] = [];
  let firstNavigate = true;
  const push = (s: Omit<ActionStep, 'id' | 'order'>) => steps.push({ id: `s${steps.length + 1}`, order: steps.length + 1, ...s } as ActionStep);
  for (const ev of kept) {
    const label = ev.target?.label || ev.target?.text || ev.target?.metadata?.name || 'field';
    switch (ev.action) {
      case 'navigate': {
        const url = ev.url ?? ev.value ?? '';
        push({
          action: 'navigate',
          value: firstNavigate && opts.jobApply ? '{{job:applyUrl}}' : url,
          timeout: 45_000,
          description: firstNavigate && opts.jobApply ? 'Open the application form' : `Open ${url}`,
          metadata: firstNavigate ? { recordedUrl: url } : undefined,
        });
        firstNavigate = false;
        break;
      }
      case 'click':
        push({ action: 'click', target: toTarget(ev.target), description: `Click "${(ev.target?.text || label).slice(0, 60)}"`, timeout: 15_000 });
        break;
      case 'upload':
        push({ action: 'upload', target: toTarget(ev.target), value: '{{userFile:resume}}', description: `Upload resume into "${label}"` });
        break;
      case 'select':
      case 'fill': {
        const value = ev.value ?? '';
        if (value.startsWith('[REDACTED')) {
          push({
            action: 'pauseForUserInput',
            expectedInput: redactedKind(value, ev.target?.metadata?.type),
            description: `Ask for "${label}"`,
            contextMessage: `Please enter your ${label}`,
            timeout: 10 * 60_000,
          });
          push({ action: 'fill', target: toTarget(ev.target), value: `{{userInput:s${steps.length}}}`, description: `Fill "${label}"`, humanType: false });
          break;
        }
        // Phone numbers match by digits ("98765 43210" = "+91 9876543210").
        const digits = value.replace(/\D/g, '');
        const token =
          byValue.get(value.trim().toLowerCase()) ??
          (digits.length >= 8 && /^[\d\s()+-]+$/.test(value)
            ? digits === (opts.profileValues?.phoneLocal ?? '')
              ? 'phoneLocal'
              : digits === (opts.profileValues?.phone ?? '').replace(/\D/g, '')
                ? 'phone'
                : undefined
            : undefined);
        push({
          action: ev.action,
          target: toTarget(ev.target),
          value: token ? `{{profile:${token}}}` : value,
          description: `${ev.action === 'select' ? 'Choose' : 'Fill'} "${label}"${token ? ` from profile (${token})` : ''}`,
          humanType: false,
        });
        break;
      }
      case 'captcha':
        push({ action: 'pauseForUserInput', expectedInput: 'captcha', description: 'Solve the CAPTCHA', timeout: 5 * 60_000 });
        break;
    }
  }
  if (opts.jobApply) {
    // The recorded final "Submit"/"Apply" click is replaced by the standard tail:
    // fill whatever the recording didn't (résumé upload, extra questions), let the
    // user review everything, then submit with confirmation detection.
    const last = steps.at(-1);
    if (last?.action === 'click' && /submit|apply|send/i.test(last.description ?? '')) steps.pop();
    push({ action: 'autofillForm', description: 'Fill the rest from the profile (résumé, other questions)', retries: 0, metadata: { openApplyButton: false } });
    push({ action: 'reviewForm', description: 'Wait for the user to approve', retries: 0 });
    push({ action: 'submitForm', description: 'Submit the application', retries: 0, timeout: 45_000 });
  }
  return steps;
}
