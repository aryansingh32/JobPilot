import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { addWorkExperience, fillPrompts, fillSignatureDates, matchEntry, parseMonthYear, repairHistoryPanels } from './workday.js';
import { pickOption } from './form-filler.js';

describe('workday helpers', () => {
  it('parses months and years', () => {
    expect(parseMonthYear('2021-06')).toEqual({ year: '2021', month: '06' });
    expect(parseMonthYear('Jun 2021')).toEqual({ year: '2021', month: '06' });
    expect(parseMonthYear('06/2021')).toEqual({ year: '2021', month: '06' });
    expect(parseMonthYear('2019')).toEqual({ year: '2019' });
    expect(parseMonthYear('soon')).toBeNull();
  });
  it('matches a panel company to a profile entry', () => {
    const xs = [{ company: 'Acme Corp' }, { company: 'Globex' }];
    expect(matchEntry(xs, 'acme corp inc')?.company).toBe('Acme Corp');
    expect(matchEntry(xs, 'Initech')).toBeNull();
  });
});

const HTML = `
<div id="workExperience-1"><input id="workExperience-1--companyName" value="Acme Corp"><div>
 <input id="workExperience-1--startDate-dateSectionMonth-input"><input id="workExperience-1--startDate-dateSectionYear-input">
 <input id="workExperience-1--endDate-dateSectionMonth-input"><input id="workExperience-1--endDate-dateSectionYear-input">
 <input type="checkbox" id="workExperience-1--currentlyWorkHere"></div></div>
<div id="workExperience-2"><input id="workExperience-2--companyName" value="">
 <input id="workExperience-2--startDate-dateSectionMonth-input"><button data-automation-id="panel-set-delete-button" onclick="this.parentElement.remove()">x</button></div>
<div id="sig"><input data-automation-id="dateSectionMonth-input"><input data-automation-id="dateSectionDay-input"><input data-automation-id="dateSectionYear-input"></div>
<div data-automation-id="formField-hear"><label>How Did You Hear About Us?</label>
 <div data-automation-id="multiselectInputContainer" id="ms" style="min-height:20px">pick
  <div id="menu" hidden><div data-automation-id="menuItem">Agency</div><div data-automation-id="menuItem">Job Board</div></div></div></div>
<script>
 document.getElementById('ms').addEventListener('click', () => document.getElementById('menu').hidden = false);
 document.querySelectorAll('[data-automation-id=menuItem]').forEach((m) => m.addEventListener('click', (e) => { e.stopPropagation();
   const chip = document.createElement('span'); chip.setAttribute('data-automation-id','selectedItem'); chip.textContent = m.textContent;
   document.querySelector('[data-automation-id=formField-hear]').appendChild(chip); document.getElementById('menu').hidden = true; }));
</script>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined) });
  page = await browser.newPage();
  await page.setContent(HTML);
});
afterAll(async () => { await browser.close(); });

describe('workday pass in the browser', () => {
  it('fills history dates from the profile, removes the phantom panel', async () => {
    const r = await repairHistoryPanels(page, { experience: [{ company: 'Acme Corp', title: 'Dev', start: '2020-03', current: true }] });
    expect(r.removed).toBe(1);
    expect(await page.locator('#workExperience-1--startDate-dateSectionMonth-input').inputValue()).toBe('03');
    expect(await page.locator('#workExperience-1--startDate-dateSectionYear-input').inputValue()).toBe('2020');
    expect(await page.locator('#workExperience-1--currentlyWorkHere').isChecked()).toBe(true);
    expect(await page.locator('#workExperience-2').count()).toBe(0);
  });
  it('signs today only outside history', async () => {
    const n = await fillSignatureDates(page, new Date('2026-10-25T12:00:00Z'));
    expect(n).toBe(3);
    expect(await page.locator('[data-automation-id=dateSectionYear-input]').first().inputValue()).toBe('2026');
    expect(await page.locator('#workExperience-1--endDate-dateSectionYear-input').inputValue()).toBe('');
  });
  it('fills a searchable prompt', async () => {
    const n = await fillPrompts(page, () => 'Job Board', pickOption);
    expect(n).toBe(1);
    expect(await page.locator('[data-automation-id=selectedItem]').textContent()).toBe('Job Board');
  });
});

describe('adding work experience from the profile', () => {
  it('opens a panel per entry, fills it, and the dates follow', async () => {
    await page.setContent(`<div data-automation-id="workExperienceSection"><button data-automation-id="add-button" id="add">Add</button><div id="panels"></div></div>
      <script>let n = 0; document.getElementById('add').onclick = () => { n++; document.getElementById('panels').insertAdjacentHTML('beforeend',
        '<div><input id="workExperience-'+n+'--jobTitle"><input id="workExperience-'+n+'--companyName"><input id="workExperience-'+n+'--location">' +
        '<textarea id="workExperience-'+n+'--roleDescription"></textarea>' +
        '<input id="workExperience-'+n+'--startDate-dateSectionMonth-input"><input id="workExperience-'+n+'--startDate-dateSectionYear-input"></div>'); };</script>`);
    const profile = { experience: [{ company: 'Acme', title: 'Engineer', location: 'Pune', start: '2021-04', highlights: ['Built APIs'] }, { company: 'Globex', title: 'Intern', start: '2019-06' }] };
    expect(await addWorkExperience(page, profile)).toBe(2);
    expect(await page.locator('[id="workExperience-2--companyName"]').inputValue()).toBe('Globex');
    expect(await page.locator('[id="workExperience-1--roleDescription"]').inputValue()).toBe('Built APIs');
    await repairHistoryPanels(page, profile);
    expect(await page.locator('[id="workExperience-1--startDate-dateSectionYear-input"]').inputValue()).toBe('2021');
    expect(await page.locator('[id="workExperience-2--startDate-dateSectionMonth-input"]').inputValue()).toBe('06');
  });
});
