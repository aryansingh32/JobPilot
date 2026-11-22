import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { resolveCandidates } from '../../packages/execution-service/locator-candidates.js';
let browser:Browser; let page:Page;
beforeAll(async()=>{browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});page=await browser.newPage();});
afterAll(async()=>{await browser?.close();});
it('skips a hidden primary candidate and an invalid selector',async()=>{
 await page.setContent('<button id="old" hidden>Save</button><button id="new">Save</button>');
 const target=await resolveCandidates(s=>page.locator(s),['[invalid', '#old','#new'],{timeout:500,visible:true});
 expect(await target.getAttribute('id')).toBe('new');
});
it('waits for a delayed fallback rather than committing to a stale primary',async()=>{
 await page.setContent('<div></div>');
 await page.evaluate(()=>setTimeout(()=>document.body.innerHTML='<button id="late">Save</button>',200));
 const target=await resolveCandidates(s=>page.locator(s),['#missing','#late'],{timeout:1000,visible:true});
 expect(await target.count()).toBe(1);
});
it('rejects ambiguous targets rather than selecting the first',async()=>{
 await page.setContent('<button>Delete</button><button>Delete</button>');
 await expect(resolveCandidates(s=>page.locator(s),['button'],{timeout:100,visible:true})).rejects.toThrow('unique');
});
it('permits a unique hidden file input for upload',async()=>{
 await page.setContent('<input type="file" hidden>');
 expect(await (await resolveCandidates(s=>page.locator(s),['input'],{timeout:100,visible:false})).count()).toBe(1);
});
