import { getPgPool } from '../db/index.js';

// ============================================================
// The arithmetic behind match scores, kept in one place so it can be tested.
//  - IDF weights: a rare skill (Rust, Kubernetes) says more about a fit than a common one (Git, SQL).
//  - Shrinkage: a job naming 1 skill must not score 100% because that 1 matched.
//  - Gaussian years fit: being 1 year short is a small penalty, 5 short is a large one — no cliff edges.
//  - Cosine similarity of sublinear-TF vectors: how close the résumé's wording is to the posting's.
// ============================================================

let idf = new Map<string, number>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
const TTL_MS = 60 * 60_000;

/** Skill frequencies across open jobs → IDF = ln((N+1)/(df+1)) + 1. Cached for an hour; failures keep the old table. */
export async function loadSkillStats(): Promise<void> {
  if (Date.now() - loadedAt < TTL_MS) return;
  loading ??= (async () => {
    try {
      const pool = getPgPool();
      const total = Number((await pool.query(`SELECT count(*) AS n FROM jobs WHERE status = 'active'`)).rows[0]?.n ?? 0);
      const { rows } = await pool.query<{ s: string; df: string }>(
        `SELECT lower(s) AS s, count(*) AS df FROM jobs, unnest(skills) AS s WHERE status = 'active' GROUP BY 1`,
      );
      const next = new Map<string, number>();
      for (const r of rows) next.set(r.s, Math.log((total + 1) / (Number(r.df) + 1)) + 1);
      if (next.size) idf = next;
      loadedAt = Date.now();
    } catch {
      loadedAt = Date.now() - TTL_MS + 5 * 60_000; // retry in five minutes
    } finally {
      loading = null;
    }
  })();
  await loading;
}

/** For tests and callers with their own table. */
export function setSkillIdf(table: Map<string, number>): void {
  idf = table;
  loadedAt = Date.now();
}

/** Weight of one skill; unknown skills count as moderately rare. */
export const skillWeight = (skill: string): number => idf.get(skill.toLowerCase()) ?? 2;

/**
 * Share of the job's skill weight the person covers (0–1), shrunk toward a prior when the job names few skills:
 * (covered·n + prior·m) / (n + m), n = skills named, m = pseudo-count.
 */
export function weightedCoverage(jobSkills: string[], has: (s: string) => boolean, prior = 0.4, m = 2): number {
  if (!jobSkills.length) return prior;
  const total = jobSkills.reduce((a, s) => a + skillWeight(s), 0);
  const got = jobSkills.filter(has).reduce((a, s) => a + skillWeight(s), 0);
  const cov = total > 0 ? got / total : 0;
  const n = jobSkills.length;
  return (cov * n + prior * m) / (n + m);
}

/**
 * How well `yours` years meets a posting's [min, max]: 1 inside; Gaussian fall-off outside.
 * Short of the minimum hurts faster (σ 1.5) than being over the maximum (σ 4).
 */
export function yearsFit(yours: number, min: number | null, max: number | null): number {
  const lo = min ?? 0;
  const hi = max ?? Number.POSITIVE_INFINITY;
  if (yours >= lo && yours <= hi) return 1;
  const gap = yours < lo ? lo - yours : yours - hi;
  const sigma = yours < lo ? 1.5 : 4;
  return Math.exp(-(gap * gap) / (2 * sigma * sigma));
}

const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the this to was we will with you your our their they them he she not but if so than then too very can may must should would about into over under per who whom which what when where how all any each more most other some such no nor only own same also just etc via within without work working team role job position candidate candidates experience years year ability strong good including include'.split(' '));

function vector(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) ?? []) {
    const t = w.replace(/\.+$/, '');
    if (t.length < 2 || STOP.has(t)) continue;
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  // Sublinear TF: repeating a word 10× is not 10× the evidence.
  for (const [k, v] of tf) tf.set(k, 1 + Math.log(v));
  return tf;
}

/** Cosine similarity of two texts (0–1). */
export function cosine(a: string, b: string): number {
  const va = vector(a);
  const vb = vector(b);
  if (!va.size || !vb.size) return 0;
  let dot = 0;
  for (const [k, v] of va) dot += v * (vb.get(k) ?? 0);
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, x) => s + x * x, 0));
  return dot / (norm(va) * norm(vb));
}

/** Cosine of résumé-vs-posting prose is small even for a good fit (~0.05–0.35): stretch it onto 0–1. */
export const stretchSimilarity = (c: number): number => 1 / (1 + Math.exp(-(c - 0.18) * 14));
