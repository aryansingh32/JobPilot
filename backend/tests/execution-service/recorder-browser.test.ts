import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { RECORDER_SCRIPT } from '../../packages/execution-service/recorder.js';
let browser: Browser;
let page: Page;
let events: any[];
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  await page?.close(); page = await browser.newPage(); events = [];
  await page.exposeFunction('reportAction', (step: any) => { events.push(step); });
});
async function record(html: string) { await page.setContent(html); await page.evaluate(RECORDER_SCRIPT); }
describe('recorder browser compatibility', () => {
  it('records inputs inside open shadow DOM', async () => {
    await record('<div id="host"></div>');
    await page.evaluate(() => { document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<input id="name">'; });
    await page.locator('#name').fill('Asha');
    await page.locator('#name').blur();
    await expect.poll(() => events.some(e => e.action === 'fill' && e.value === 'Asha')).toBe(true);
  });
  it('uses the actual data-qa attribute in selector candidates', async () => {
    await record('<button data-qa="save">Save</button>');
    await page.getByText('Save').click();
    await expect.poll(() => events.length).toBeGreaterThan(0);
    const event = events.find(e => e.action === 'click');
    expect(await page.locator(event.target.selectors[0]).count()).toBe(1);
  });
  it('escapes quoted attribute values', async () => {
    await record('<input name="customer&quot;name"><button>Done</button>');
    await page.locator('input').fill('Asha'); await page.getByText('Done').click();
    await expect.poll(() => events.some(e => e.action === 'fill')).toBe(true);
    const event = events.find(e => e.action === 'fill');
    expect(await page.locator(event.target.selectors[0]).count()).toBe(1);
  });
  it('redacts password input', async () => {
    await record('<input type="password"><button>Done</button>');
    await page.locator('input').fill('example-secret'); await page.getByText('Done').click();
    await expect.poll(() => events.some(e => e.action === 'fill')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('example-secret');
  });
});
