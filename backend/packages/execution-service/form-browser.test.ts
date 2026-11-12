import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { fillField, invalidFieldIdx, scanForm, verifyFilled } from './form-filler.js';

const FORM = `<form>
<label for="fn">First name *</label><input id="fn" name="first_name" required>
<label for="ph">Phone *</label><input id="ph" name="phone" maxlength="5" required>
<input name="beecatcher" style="position:absolute;left:-5000px" tabindex="-1">
<label for="c">Country *</label>
<div id="rs"><input id="c" role="combobox" aria-expanded="false" aria-autocomplete="list"><div id="sv"></div><div id="menu" role="listbox" hidden></div></div>
<script>
  const c = document.getElementById('c'), menu = document.getElementById('menu'), sv = document.getElementById('sv');
  const opts = ['Australia','United States','Austria'];
  const show = () => { menu.hidden = false; c.setAttribute('aria-expanded','true'); menu.innerHTML = opts.map(o => '<div role="option">'+o+'</div>').join(''); };
  c.addEventListener('focus', show); c.addEventListener('click', show);
  // commits on mousedown only, like react-select (a bare click handler does nothing)
  menu.addEventListener('mousedown', e => { const o = e.target.closest('[role=option]'); if (!o) return; sv.className='singleValue'; sv.textContent = o.textContent; menu.hidden = true; c.setAttribute('aria-expanded','false'); c.value=''; });
</script></form>`;

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined) }); page = await browser.newPage(); });
afterAll(async () => { await browser.close(); });

const frameHost = `<h1>Careers</h1><iframe id="f" srcdoc='${FORM.replace(/'/g, '&#39;')}' style="width:600px;height:500px"></iframe>`;

describe('form scanning in the browser', () => {
  it('finds a form inside an iframe, skips the honeypot, fills and verifies', async () => {
    await page.setContent(frameHost);
    await page.waitForTimeout(300);
    const fields = await scanForm(page);
    const labels = fields.map((f) => f.label);
    expect(labels).toContain('First name');
    expect(fields.some((f) => f.name === 'beecatcher')).toBe(false);
    const fn = fields.find((f) => f.name === 'first_name')!;
    await fillField(page, { field: fn, value: 'Asha' });
    expect((await verifyFilled(page, fn, 'Asha'))?.state).toBe('ok');
    const ph = fields.find((f) => f.name === 'phone')!;
    await fillField(page, { field: ph, value: '+91 98765 43210' });
    expect((await verifyFilled(page, ph, '+91 98765 43210'))?.state).toBe('truncated');
  });

  it('commits a mousedown-only dropdown and picks US, not Australia', async () => {
    await page.setContent(FORM);
    const fields = await scanForm(page);
    const c = fields.find((f) => f.type === 'combobox')!;
    await fillField(page, { field: c, value: 'US' }).catch((e) => { throw e; });
    expect(await page.locator('#sv').textContent()).toBe('United States');
  });

  it('flags invalid fields', async () => {
    await page.setContent(FORM);
    await scanForm(page);
    expect((await invalidFieldIdx(page)).length).toBeGreaterThan(0);
  });
});

describe('split date widgets', () => {
  it('scans month/day/year boxes as one date and fills all three', async () => {
    await page.setContent(`<div data-automation-id="formField-dob"><label>Date of Birth</label>
      <input data-automation-id="dateSectionMonth-input"><input data-automation-id="dateSectionDay-input"><input data-automation-id="dateSectionYear-input"></div>`);
    const fields = await scanForm(page);
    const d = fields.filter((f) => f.type === 'datesplit');
    expect(d).toHaveLength(1);
    expect(fields).toHaveLength(1);
    await fillField(page, { field: d[0], value: '05/03/1999' });
    expect(await page.locator('[data-automation-id=dateSectionMonth-input]').inputValue()).toBe('03');
    expect(await page.locator('[data-automation-id=dateSectionDay-input]').inputValue()).toBe('05');
    expect(await page.locator('[data-automation-id=dateSectionYear-input]').inputValue()).toBe('1999');
  });
});
