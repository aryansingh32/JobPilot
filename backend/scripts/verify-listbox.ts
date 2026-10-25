import { chromium } from 'playwright';
import { scanForm, fillField } from '../packages/execution-service/form-filler.js';

const html = `<label id="l1">Country *</label>
<button id="c" aria-haspopup="listbox" aria-labelledby="l1">Select One</button>
<ul id="m" role="listbox" style="display:none"><li role="option">India</li><li role="option">United States of America</li></ul>
<script>const b=document.getElementById('c'),m=document.getElementById('m');
b.onclick=()=>{m.style.display='block'};
m.querySelectorAll('li').forEach(li=>li.onclick=()=>{b.textContent=li.textContent;m.style.display='none'});</script>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.setContent(html);
const fields = await scanForm(page);
console.log(fields.map((f) => `${f.type}|${f.label}|req=${f.required}|val=${f.value}`));
await fillField(page, { field: fields[0], value: 'United States' });
console.log('after:', await page.locator('#c').innerText());
await browser.close();
