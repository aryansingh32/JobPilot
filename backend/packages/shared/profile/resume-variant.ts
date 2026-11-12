// A person may keep several résumés ("backend", "data", "design"): the one that fits the role's title is sent.
export interface ResumeVariant {
  /** Short name the person gave it ("Backend", "Data science"). */
  label: string;
  fileId: string;
  fileName?: string;
  /** Extra words that mean this résumé suits a role ("golang", "etl"). The label counts too. */
  keywords?: string[];
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 1);

/** The variant whose label/keywords best match the job title (and, weakly, its skills); null = use the main résumé. */
export function pickResumeVariant(variants: ResumeVariant[] | undefined, title: string, skills: string[] = []): ResumeVariant | null {
  if (!variants?.length || !title) return null;
  const t = new Set(words(title));
  const sk = new Set(skills.flatMap(words));
  let best: { v: ResumeVariant; score: number } | null = null;
  for (const v of variants) {
    const terms = [...words(v.label), ...(v.keywords ?? []).flatMap(words)];
    // A title hit is worth far more than a skills hit, so "Backend Engineer" never loses to a skills coincidence.
    const score = terms.reduce((n, w) => n + (t.has(w) ? 10 : sk.has(w) ? 1 : 0), 0);
    if (score >= 10 && (!best || score > best.score)) best = { v, score };
  }
  return best?.v ?? null;
}
