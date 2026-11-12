import type { Page } from 'playwright';
import type { ProfileData } from '../shared/profile/index.js';

// ============================================================
// WORKDAY PASS — the parts of a Workday application the generic scanner can't
// do on its own, driven by Workday's own data-automation-id / id conventions:
//   • résumé-parsed Work Experience / Education panels (dates left empty, phantom panels)
//   • signature-block dates (today), as opposed to history dates (a month/year range)
//   • searchable prompts (“How Did You Hear About Us?”, Field of Study)
// Runs on each page before the generic scan; harmless where those widgets are absent.
// ============================================================

export const isWorkday = (page: Page): boolean => /myworkdayjobs\.com|\.workday\.com|wd\d+\.myworkday/i.test(page.url());

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const MONTH = (m: number) => String(m).padStart(2, '0');

/** "2021-06", "06/2021", "Jun 2021", "2021" → { month, year } (month may be missing). */
export function parseMonthYear(v: string | undefined): { month?: string; year: string } | null {
  if (!v) return null;
  const t = v.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})/);
  if (m) return { year: m[1], month: MONTH(Number(m[2])) };
  m = t.match(/^(\d{1,2})[/-](\d{4})$/);
  if (m) return { year: m[2], month: MONTH(Number(m[1])) };
  const names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = t.toLowerCase().match(/^([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/);
  if (m && names.includes(m[1])) return { year: m[2], month: MONTH(names.indexOf(m[1]) + 1) };
  m = t.match(/^(\d{4})$/);
  return m ? { year: m[1] } : null;
}

/** Which entry of the profile a panel's company / school belongs to. */
export function matchEntry<T extends { company?: string; school?: string }>(entries: T[], name: string): T | null {
  const n = norm(name);
  if (!n) return null;
  return entries.find((e) => {
    const k = norm(e.company ?? e.school ?? '');
    return k && (k === n || k.includes(n) || n.includes(k));
  }) ?? null;
}

async function deletePanel(page: Page, anyInput: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    for (let n: Element | null = el, i = 0; n && i < 12; n = n.parentElement, i++) {
      const b = n.querySelector('button[data-automation-id="panel-set-delete-button"], button[aria-label*="Delete" i]') as HTMLElement | null;
      if (b) { b.click(); return true; }
    }
    return false;
  }, anyInput).catch(() => false);
}

/**
 * Workday parses the uploaded résumé into panels; its From/To inputs are often empty. Group inputs by panel
 * (workExperience-4--startDate-dateSectionMonth-input → workExperience-4), fill real dates from the profile entry
 * with the same company/school, and remove panels that name nothing (phantoms) or nothing the profile knows.
 */
export async function repairHistoryPanels(page: Page, profile: ProfileData): Promise<{ filled: number; removed: number }> {
  let filled = 0;
  let removed = 0;
  const groups = await page.evaluate(() => {
    const out: Record<string, Array<{ id: string; value: string }>> = {};
    document.querySelectorAll('input[id*="workExperience"][id*="dateSection"], input[id*="education"][id*="dateSection"]').forEach((e) => {
      const input = e as HTMLInputElement;
      const r = input.getBoundingClientRect();
      if (!input.id || r.width <= 0) return;
      (out[input.id.split('--')[0]] ||= []).push({ id: input.id, value: input.value });
    });
    return out;
  }).catch(() => ({} as Record<string, Array<{ id: string; value: string }>>));

  for (const [prefix, inputs] of Object.entries(groups)) {
    const empties = inputs.filter((i) => !i.value.trim());
    if (!empties.length) continue;
    const name = await page.evaluate((p) => {
      const el = document.querySelector(`input[id^="${p}--"][id*="ompany"], input[id^="${p}--"][id*="chool"]`) as HTMLInputElement | null;
      return el?.value.trim() ?? '';
    }, prefix).catch(() => '');
    const isEducation = /education/i.test(prefix);
    const entry = isEducation ? matchEntry(profile.education ?? [], name) : matchEntry(profile.experience ?? [], name);
    if (!name || !entry) {
      // A panel naming nothing — or something the person never listed — is a phantom the parser made up.
      if (await deletePanel(page, `[id="${empties[0].id}"]`)) { removed++; await page.waitForTimeout(800); }
      continue;
    }
    const start = parseMonthYear(entry.start);
    const current = 'current' in entry && (entry as { current?: boolean }).current;
    const end = current ? null : parseMonthYear(entry.end);
    for (const i of empties) {
      const id = i.id.toLowerCase();
      const isStart = /startdate|firstyear/.test(id);
      const part = isStart ? start : end;
      const value = part ? (id.includes('month') ? part.month : id.includes('year') ? part.year : undefined) : undefined;
      if (!value) continue;
      const box = page.locator(`[id="${i.id}"]`).first();
      await box.fill(value, { timeout: 3_000 }).catch(() => {});
      await box.press('Tab').catch(() => {});
      filled++;
    }
    if (current) {
      const cb = page.locator(`input[type="checkbox"][id^="${prefix}--"][id*="urrently"]`).first();
      if (await cb.count() && !(await cb.isChecked().catch(() => true))) await cb.check({ force: true }).catch(() => {});
    }
  }
  return { filled, removed };
}

/**
 * "Autofill with résumé" not used (or nothing parsed): open the Work Experience panels ourselves from the profile.
 * Only the plain-text parts are filled here; the dates are set right after by repairHistoryPanels.
 */
export async function addWorkExperience(page: Page, profile: ProfileData): Promise<number> {
  const section = page.locator('[data-automation-id="workExperienceSection"]').first();
  if (!(await section.isVisible().catch(() => false))) return 0;
  // Panels already there (parsed from the résumé): leave them to the repair pass.
  if (await page.locator('input[id^="workExperience-"][id*="--"]').count()) return 0;
  let added = 0;
  for (const e of (profile.experience ?? []).slice(0, 3)) {
    const add = section.locator('[data-automation-id="add-button"], button:has-text("Add")').first();
    if (!(await add.isVisible().catch(() => false))) break;
    await add.click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(900);
    const prefix = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('input[id^="workExperience-"]')).map((i) => i.id.split('--')[0]);
      return ids.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0] ?? '';
    }).catch(() => '');
    if (!prefix) break;
    for (const [suffix, value] of [['jobTitle', e.title], ['companyName', e.company], ['location', e.location]] as const) {
      if (!value) continue;
      await page.locator(`[id="${prefix}--${suffix}"]`).first().fill(value, { timeout: 3_000 }).catch(() => {});
    }
    const text = (e.highlights ?? []).join('\n').slice(0, 1500);
    if (text) await page.locator(`[id="${prefix}--roleDescription"]`).first().fill(text, { timeout: 3_000 }).catch(() => {});
    added++;
  }
  return added;
}

/** Today's date into signature blocks (dateSection inputs outside any history panel). */
export async function fillSignatureDates(page: Page, now = new Date()): Promise<number> {
  const parts: Record<string, string> = {
    'dateSectionMonth-input': MONTH(now.getMonth() + 1),
    'dateSectionDay-input': MONTH(now.getDate()),
    'dateSectionYear-input': String(now.getFullYear()),
  };
  let n = 0;
  for (const [aid, value] of Object.entries(parts)) {
    const boxes = page.locator(`input[data-automation-id="${aid}"]`);
    for (let i = 0; i < await boxes.count(); i++) {
      const b = boxes.nth(i);
      if (!(await b.isVisible().catch(() => false)) || (await b.inputValue().catch(() => 'x')).trim()) continue;
      const inHistory = await b.evaluate((el) => !!el.closest('[id*="education" i], [id*="workExperience" i], [id*="experience" i]')).catch(() => true);
      if (inHistory) continue;
      await b.fill(value, { timeout: 3_000 }).catch(() => {});
      n++;
    }
  }
  return n;
}

const promptOptions = (page: Page) => page.locator('[data-automation-id="menuItem"]:visible, [data-automation-id="activeListContainer"] [data-automation-id="promptOption"]:visible');

/**
 * Searchable prompts: open, browse the list first (typing can filter everything out), pick the best entry for the
 * wanted wording, falling back through generic honest sources, then confirm something was chosen.
 */
export async function fillPrompts(page: Page, wanted: (label: string) => string | null, pick: (options: string[], want: string) => string | null): Promise<number> {
  let done = 0;
  const containers = page.locator('[data-automation-id="multiselectInputContainer"], input[data-automation-id="searchBox"]');
  const count = await containers.count();
  for (let i = 0; i < count; i++) {
    const c = containers.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    const has = await c.evaluate((el) => {
      const scope = el.closest('[data-automation-id^="formField"]') ?? el.closest('li') ?? el.parentElement;
      return !!scope?.querySelector('[data-automation-id="selectedItem"], [data-automation-id="deleteSelectedItem"]') || /[1-9]\d* items? selected/.test(scope?.textContent ?? '');
    }).catch(() => true);
    if (has) continue;
    const label = await c.evaluate((el) => {
      const scope = el.closest('[data-automation-id^="formField"]');
      return (scope?.querySelector('label')?.textContent ?? el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').replace(/\*/g, '').trim();
    }).catch(() => '');
    const want = wanted(label);
    const wants = [want, 'LinkedIn', 'Job Board', 'Career Site', 'Company Website', 'Other'].filter((x): x is string => !!x);
    await c.click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(900);
    let typed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const opts = promptOptions(page);
      const texts = (await opts.allInnerTexts().catch(() => [] as string[])).map((t) => t.replace(/\s+/g, ' ').trim());
      if (!texts.length) {
        if (!typed && want) {
          await page.keyboard.type(want.slice(0, 25), { delay: 40 }).catch(() => {});
          await page.keyboard.press('Enter').catch(() => {});
          await page.waitForTimeout(1200);
          typed = true;
          continue;
        }
        break;
      }
      let chosen: string | null = null;
      for (const w of wants) { chosen = pick(texts, w); if (chosen) break; }
      // Required prompts get something rather than nothing: the list's own "Other", else its first entry.
      chosen ??= texts.find((t) => /^other$/i.test(t)) ?? texts[0];
      await opts.nth(texts.indexOf(chosen)).click({ timeout: 3_000, force: true }).catch(() => {});
      await page.waitForTimeout(900);
      const now = await c.evaluate((el) => !!(el.closest('[data-automation-id^="formField"]') ?? el.closest('li') ?? el.parentElement)?.querySelector('[data-automation-id="selectedItem"]')).catch(() => false);
      if (now) { done++; break; }
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return done;
}

/** Everything Workday-specific that runs before a page is scanned. */
export async function workdayPass(
  page: Page,
  profile: ProfileData,
  helpers: { wanted: (label: string) => string | null; pick: (options: string[], want: string) => string | null },
): Promise<{ filled: number; removed: number; dates: number; prompts: number }> {
  if (!isWorkday(page)) return { filled: 0, removed: 0, dates: 0, prompts: 0 };
  const created = await addWorkExperience(page, profile).catch(() => 0);
  const history = await repairHistoryPanels(page, profile).catch(() => ({ filled: 0, removed: 0 }));
  const dates = await fillSignatureDates(page).catch(() => 0);
  const prompts = await fillPrompts(page, helpers.wanted, helpers.pick).catch(() => 0);
  return { ...history, filled: history.filled + created, dates, prompts };
}
