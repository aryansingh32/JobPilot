/** A reviewed URL-specific recording can support a site without an ATS adapter. */
export function supportsRecordedJob(url: string, atsType: string, workflows: Array<{ ats?: string; patterns?: string[] }>): boolean {
  return workflows.some(w => {
    if (!w.ats || w.ats === 'generic') return false;
    if (w.ats === atsType && w.ats !== 'recorded') return true;
    return (w.patterns ?? []).some(pattern => {
      try { return new RegExp(pattern, 'i').test(url); } catch { return false; }
    });
  });
}
