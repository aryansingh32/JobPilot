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
  target?: { selectors?: string[]; text?: string; tag?: string; label?: string; metadata?: { type?: string; name?: string; role?: string } };
  value?: string;
  url?: string;
  frameUrl?: string;
  tab?: number;
  timestamp?: number;
  snapshot?: { title?: string; headings?: string[] };
}

/** What the page looked like after the recorded final click — how this site says "received". */
export interface ConfirmationHint {
  /** Path of the confirmation page, when the final click led to another URL. */
  urlPath?: string;
  /** Headline text of that page (a heading, never typed values). */
  text?: string;
}

export interface CompileResult {
  steps: ActionStep[];
  /** Things the recording did that the compiler refused to bake into a shared workflow. */
  warnings: string[];
  confirmation?: ConfirmationHint;
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

const lastIndexOf = <T,>(arr: T[], pred: (v: T) => boolean): number => {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
};

/**
 * Steps recorded inside an iframe run through the executor's `iframe` step, which matches the frame by URL.
 * Consecutive steps of one frame share a wrapper. Ids are kept (user-input tokens refer to them); only order is renumbered.
 */
function wrapFrames(steps: ActionStep[]): ActionStep[] {
  const out: ActionStep[] = [];
  for (const st of steps) {
    const frameUrl = st.metadata?.frameUrl as string | undefined;
    if (frameUrl && st.action !== 'pauseForUserInput') {
      const inner = { ...st, metadata: { ...st.metadata } };
      delete inner.metadata!.frameUrl;
      const prev = out.at(-1);
      if (prev?.action === 'iframe' && prev.metadata?.frameUrl === frameUrl) {
        prev.trueSteps!.push(inner);
        continue;
      }
      let match = frameUrl;
      try {
        const u = new URL(frameUrl);
        match = u.origin + u.pathname;
      } catch { /* keep as is */ }
      out.push({
        id: `f${out.length + 1}`,
        order: 0,
        action: 'iframe',
        value: match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        description: `Inside the embedded form (${match.slice(0, 60)})`,
        metadata: { frameUrl },
        trueSteps: [inner],
      } as ActionStep);
      continue;
    }
    out.push(st);
  }
  return out.map((st, i) => {
    const meta = { ...st.metadata };
    if (st.action !== 'iframe') delete meta.frameUrl;
    return { ...st, order: i + 1, metadata: Object.keys(meta).length ? meta : undefined } as ActionStep;
  });
}

/** Clicks that move through the flow; anything else in a job form is an answer a person gave. */
const NAVIGATION_CLICK = /\b(apply|next|continue|submit|sign.?in|log.?in|sign.?up|create|register|accept|start|manual|autofill|upload|use my|back|save|proceed|got it|agree|close|dismiss|reject|decline)\b/i;

function isAnswerClick(ev: RawStep): boolean {
  const type = ev.target?.metadata?.type;
  if (ev.target?.tag === 'input' && (type === 'radio' || type === 'checkbox')) return true;
  if (ev.target?.metadata?.role === 'option' || ev.target?.tag === 'label') return true;
  // A list item, div or span with answer-like text ("Yes", "5 years") in a custom dropdown.
  if (['li', 'div', 'span'].includes(ev.target?.tag ?? '')) return !NAVIGATION_CLICK.test(ev.target?.text ?? '');
  return false;
}

export function compileRecording(raw: RawStep[], opts: CompileOptions = {}): ActionStep[] {
  return compileRecordingDetailed(raw, opts).steps;
}

export function compileRecordingDetailed(raw: RawStep[], opts: CompileOptions = {}): CompileResult {
  const warnings: string[] = [];
  const confirmation = opts.jobApply ? confirmationFrom(raw) : undefined;
  const byValue = new Map<string, string>();
  for (const [key, value] of Object.entries(opts.profileValues ?? {})) {
    if (value && value.length > 1 && !byValue.has(value.trim().toLowerCase())) byValue.set(value.trim().toLowerCase(), key);
  }

  // 1. Last value wins per field; consecutive duplicate clicks collapse.
  const events: RawStep[] = [];
  for (const ev of raw) {
    if (ev.action === 'input') ev.action = 'fill';
    if (!['navigate', 'click', 'fill', 'select', 'upload', 'change', 'captcha', 'press', 'dialog', 'download'].includes(ev.action)) continue;
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
  let currentTab = 0;
  let curFrame: string | undefined;
  const frameMeta = () => (curFrame ? { frameUrl: curFrame } : {});
  const push = (s: Omit<ActionStep, 'id' | 'order'>) =>
    steps.push({ id: `s${steps.length + 1}`, order: steps.length + 1, ...s, metadata: { ...s.metadata, ...frameMeta() } } as ActionStep);
  for (const ev of kept) {
    curFrame = ev.frameUrl;
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
        // A shared job workflow never replays one person's answers (a radio, a dropdown choice): the profile fills those.
        if (opts.jobApply && isAnswerClick(ev)) {
          warnings.push(`Skipped a click on "${(ev.target?.text || label).slice(0, 50)}" — it looks like an answer, which the profile fills`);
          break;
        }
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
        // A typed answer that isn't from the profile belongs to the person who recorded it, not to every applicant.
        if (opts.jobApply && !token) {
          warnings.push(`Skipped "${label}" — the value typed isn't in the test profile, so it would be replayed for every applicant`);
          break;
        }
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
      case 'press':
        push({ action: 'pressKey', target: toTarget(ev.target), value: ev.value ?? 'Enter', description: `Press ${ev.value ?? 'Enter'} in "${label}"` });
        break;
      case 'dialog': {
        // The handler must be armed before the click that raises the alert, so it goes in front of that click.
        const at = lastIndexOf(steps, (st) => st.action === 'click' || st.action === 'pressKey');
        const arm = { action: 'acceptDialog', description: `Accept the site's pop-up: "${(ev.value ?? '').slice(0, 60)}"` } as const;
        if (at < 0) push({ ...arm });
        else steps.splice(at, 0, { id: `d${steps.length + 1}`, order: 0, ...arm, metadata: frameMeta() } as ActionStep);
        break;
      }
      case 'download': {
        // The click that started the download becomes the download step itself.
        const last = steps.at(-1);
        if (last?.action === 'click') {
          last.action = 'download';
          last.description = `Download ${ev.value || 'the file'}`;
          last.timeout = 60_000;
        } else {
          warnings.push(`A download (${ev.value || 'file'}) started without a click — it was not recorded as a step`);
        }
        break;
      }
    }
    // A click that opened another window: follow it so the next steps run there.
    if (ev.action === 'click' || ev.action === 'press') {
      const nextTab = kept[kept.indexOf(ev) + 1]?.tab ?? 0;
      if (nextTab !== currentTab) {
        push({ action: 'wait', value: '1500', description: 'Wait for the site to open another window' });
        push({ action: 'switchTab', value: String(nextTab), description: nextTab ? 'Switch to the new window' : 'Back to the first window', timeout: 15_000 });
        currentTab = nextTab;
      }
    }
  }
  const framed = wrapFrames(steps);
  steps.splice(0, steps.length, ...framed);
  if (opts.jobApply) {
    // The recorded final "Submit"/"Apply" click is replaced by the standard tail:
    // fill whatever the recording didn't (résumé upload, extra questions), let the
    // user review everything, then submit with confirmation detection.
    const last = steps.at(-1);
    if (last?.action === 'click' && /submit|apply|send/i.test(last.description ?? '')) steps.pop();
    push({ action: 'autofillForm', description: 'Fill the rest from the profile (résumé, other questions)', retries: 0, metadata: { openApplyButton: false } });
    push({ action: 'reviewForm', description: 'Wait for the user to approve', retries: 0 });
    push({
      action: 'submitForm',
      description: 'Submit the application',
      retries: 0,
      timeout: 45_000,
      ...(confirmation ? { metadata: { confirmation } } : {}),
    });
  }
  return { steps, warnings, confirmation };
}

/**
 * The page the recording ended on, if the last real click was a Submit/Apply that led somewhere:
 * its path and headline become this site's own "received" signal for submitForm.
 */
function confirmationFrom(raw: RawStep[]): ConfirmationHint | undefined {
  let click = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i].action === 'click' && /submit|apply|send/i.test(raw[i].target?.text ?? raw[i].target?.label ?? '')) { click = i; break; }
  }
  if (click < 0) return undefined;
  const after = raw.slice(click + 1).filter((e) => e.action === 'page' && e.url);
  const landed = after.at(-1);
  if (!landed?.url) return undefined;
  const before = [...raw.slice(0, click)].reverse().find((e) => e.url)?.url;
  let urlPath: string | undefined;
  try {
    const u = new URL(landed.url);
    if (!before || new URL(before).pathname !== u.pathname) urlPath = u.pathname;
  } catch { /* not a URL */ }
  const text = (landed.snapshot?.headings ?? []).find((h) => h.length >= 6 && h.length <= 120);
  return urlPath || text ? { ...(urlPath ? { urlPath } : {}), ...(text ? { text } : {}) } : undefined;
}
