import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
const pool = vi.hoisted(() => ({ acquireContext: vi.fn(async () => ({ contextId: 'test' })), getOrCreatePage: vi.fn(), releaseContext: vi.fn() }));
vi.mock('../../packages/execution-service/browser-pool.js', () => ({ getBrowserPool: () => pool }));
vi.mock('../../packages/execution-service/selector-engine.js', () => ({ SelectorEngine: class {} }));
vi.mock('../../packages/execution-service/executor.js', () => ({ resolveLocator: (step: any, ctx: any) => ctx.page.locator(step.target.value) }));
import { DryRunService } from '../../packages/execution-service/dry-run-service.js';
let browser: Browser; let page: Page;
const url = 'https://fixture.example/';
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => { await page?.close(); page = await browser.newPage(); pool.getOrCreatePage.mockResolvedValue(page); await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<button onclick="document.title=\'SUBMITTED\'">Submit</button>' })); });
describe('dry run must not claim untested success', () => {
  it('fails an incorrect URL assertion', async () => { expect((await new DryRunService().runDryRun(url, [{ id: 'url', action: 'assertURL', value: '/wrong' }])).success).toBe(false); });
  it('does not pass an entirely skipped workflow', async () => { expect((await new DryRunService().runDryRun(url, [{ id: 'up', action: 'upload', value: '{{userFile:document}}' }])).success).toBe(false); });
  it('does not click a real submission button', async () => {
    const r = await new DryRunService().runDryRun(url, [{ id: 'send', action: 'click', target: { value: 'button' } }]);
    expect(await page.title()).not.toBe('SUBMITTED'); expect(r.success).toBe(false);
  });
  it('does not certify an empty plan', async () => { expect((await new DryRunService().runDryRun(url, [])).success).toBe(false); });
});
