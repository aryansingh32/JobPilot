// ============================================================
// AUTO-SUBMIT POLICY — Auto Apply may send an application without a person looking at it only when
// nothing in it was guessed: every answer comes from the profile, a remembered reply, an earlier
// answer the person gave, a safe default (never worked there, decline-to-state) or the form itself.
// An answer a model wrote, or a required question nobody answered, waits for review.
// ============================================================

export interface PlannedAnswer { source: string; key?: string; label?: string }

const SENSITIVE_DECLARATION = /work authori[sz]|authori[sz]ed to work|visa|sponsorship|disability|veteran|race|ethnic|criminal|background check|legally|under penalty|truthful|accurate|attest|convict|felony|demographic/i;

export function canAutoSubmit(answers: PlannedAnswer[], missing: unknown[] = []): { ok: boolean; reason?: string } {
  if (missing.length) return { ok: false, reason: `${missing.length} required question${missing.length === 1 ? '' : 's'} still unanswered` };
  const ai = answers.filter((a) => a.source === 'ai').length;
  if (ai) return { ok: false, reason: `${ai} answer${ai === 1 ? ' was' : 's were'} written by AI` };
  const sensitive = answers.filter((a) => SENSITIVE_DECLARATION.test(`${a.label ?? ''} ${a.key ?? ''}`)).length;
  if (sensitive) return { ok: false, reason: `${sensitive} sensitive declaration${sensitive === 1 ? ' needs' : 's need'} your confirmation` };
  return { ok: true };
}
