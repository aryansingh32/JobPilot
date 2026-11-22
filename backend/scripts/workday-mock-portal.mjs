#!/usr/bin/env node
/**
 * A mock Workday-style application: one URL, client-rendered pages, buttons that open listboxes
 * ("Select One"), required radios / checkboxes, a resume upload, and Next that refuses a page with
 * empty required fields. Pages: My Information → My Experience → Application Questions →
 * Voluntary Disclosures → Self Identify → Review (Next reads "Submit").
 * Used by verify-workday-flow.ts; also runnable alone: node scripts/workday-mock-portal.mjs 4466
 */
import http from 'http';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Mock Workday</title>
<style>body{font-family:sans-serif;max-width:680px;margin:24px auto}.row{margin:12px 0}label{display:block;font-weight:600;margin-bottom:4px}
input[type=text],input[type=tel]{width:100%;padding:6px;box-sizing:border-box}button{padding:8px 12px}
.dd{width:100%;text-align:left;background:#fff;border:1px solid #888}ul[role=listbox]{list-style:none;margin:2px 0;padding:0;border:1px solid #888;background:#fff;position:absolute;z-index:9;min-width:300px}
li[role=option]{padding:6px 10px;cursor:pointer}li[role=option]:hover{background:#eef}.err{color:#b00}</style></head><body>
<h3 data-automation-id="progressBarActiveStep" id="step"></h3><div id="root"></div><div id="errors" role="alert" class="err" data-automation-id="errorMessage"></div>
<div class="row"><button data-automation-id="bottom-navigation-next-button" id="next">Next</button></div>
<script>
const DD = {
  source: ['LinkedIn','Company website','Job board','Employee referral','Other'],
  country: ['United States of America','India','Canada','United Kingdom'],
  state: ['California','Texas','Washington','Karnataka','Bihar'],
  phoneType: ['Mobile','Home','Work'],
  phoneCode: ['United States of America (+1)','India (+91)','United Kingdom (+44)'],
  yesno: ['Yes','No'],
  gender: ['Male','Female','Decline to self identify'],
  hispanic: ['Yes','No','Decline to self identify'],
  veteran: ['I am not a protected veteran','I identify as a protected veteran','I do not wish to answer'],
  disability: ['Yes, I have a disability','No, I do not have a disability','I do not want to answer'],
};
const PAGES = [
  { title: 'My Information', fields: [
    ['dd','source','How Did You Hear About Us?',1],['dd','country','Country',1,'United States of America'],
    ['text','given','Given Name(s)',1],['text','family','Family Name',1],['text','addr','Address Line 1',1],['text','city','City',1],
    ['dd','state','State',1],['text','postal','Postal Code',1],['dd','phoneType','Phone Device Type',1],['dd','phoneCode','Country Phone Code',1],['tel','phone','Phone Number',1]]},
  { title: 'My Experience', fields: [['file','resume','Resume/CV',1],['text','linkedin','LinkedIn Profile',0]]},
  { title: 'Application Questions', fields: [
    ['dd','auth','Are you legally authorized to work in the United States?',1,null,'yesno'],
    ['radio','sponsor','Will you now or in the future require sponsorship for employment visa status?',1,['Yes','No']],
    ['dd','relocate','Are you willing to relocate?',1,null,'yesno'],['text','salary','What are your salary expectations?',1]]},
  { title: 'Voluntary Disclosures', fields: [
    ['dd','gender','Gender',1],['dd','hispanic','Are you Hispanic/Latino?',1],['dd','veteran','Veteran Status',1],
    ['check','terms','I have read and consent to the terms and conditions.',1]]},
  { title: 'Self Identify', fields: [['dd','disability','Disability Status',1],['text','sigName','Name',1],['text','sigDate','Date',1]]},
  { title: 'Review', fields: [] },
];
let page = 0; const values = {};
const root = document.getElementById('root'), err = document.getElementById('errors'), next = document.getElementById('next');
function closeLists(){ document.querySelectorAll('ul[role=listbox]').forEach(u=>u.remove()); }
function render(){
  closeLists(); err.textContent=''; const p = PAGES[page];
  document.getElementById('step').textContent = p.title;
  next.textContent = page === PAGES.length-1 ? 'Submit' : 'Next';
  root.innerHTML = '';
  if (page === PAGES.length-1) { root.innerHTML = '<p>Review your application.</p><pre id="summary">'+JSON.stringify(values,null,1)+'</pre>'; return; }
  for (const [kind,key,label,req,extra,list] of p.fields) {
    const row = document.createElement('div'); row.className='row'; row.dataset.automationId='formField-'+key;
    const id='f-'+key; const lab=document.createElement('label'); lab.id='l-'+key; lab.textContent=label+(req?' *':''); if(kind!=='check') row.appendChild(lab);
    if (kind==='dd') {
      if (!(key in values) && extra) values[key]=extra;
      const b=document.createElement('button'); b.type='button'; b.className='dd'; b.id=id; b.setAttribute('aria-haspopup','listbox'); b.setAttribute('aria-labelledby','l-'+key);
      b.textContent = values[key] || 'Select One';
      b.onclick=()=>{ closeLists(); const ul=document.createElement('ul'); ul.setAttribute('role','listbox');
        for(const o of DD[list||key]){ const li=document.createElement('li'); li.setAttribute('role','option'); li.textContent=o; li.onclick=()=>{values[key]=o;b.textContent=o;closeLists();}; ul.appendChild(li);} b.after(ul); };
      row.appendChild(b);
    } else if (kind==='radio') {
      const fs=document.createElement('fieldset'); const lg=document.createElement('legend'); lg.textContent=label+' *'; fs.appendChild(lg); lab.remove();
      for(const o of extra){ const l=document.createElement('label'); const r=document.createElement('input'); r.type='radio'; r.name=key; r.value=o; r.checked=values[key]===o; r.onchange=()=>values[key]=o; l.append(r,' '+o); fs.appendChild(l);} row.appendChild(fs);
    } else if (kind==='check') {
      const l=document.createElement('label'); const c=document.createElement('input'); c.type='checkbox'; c.id=id; c.required=true; c.checked=!!values[key]; c.onchange=()=>values[key]=c.checked; l.append(c,' '+label+' *'); row.appendChild(l);
    } else if (kind==='file') {
      const i=document.createElement('input'); i.type='file'; i.id=id; i.onchange=()=>values[key]=i.files[0]?.name||''; row.appendChild(i);
    } else {
      const i=document.createElement('input'); i.type=kind; i.id=id; i.setAttribute('aria-required',req?'true':'false'); i.value=values[key]||''; i.oninput=()=>values[key]=i.value; row.appendChild(i);
    }
    root.appendChild(row);
  }
}
next.onclick = async () => {
  if (page === PAGES.length-1) { await fetch('/submitted',{method:'POST',body:JSON.stringify(values)}); root.innerHTML='<h2>Application submitted</h2>'; next.remove(); return; }
  const missing = PAGES[page].fields.filter(f=>f[3] && !values[f[1]]).map(f=>f[2]);
  if (missing.length) { err.textContent = 'Errors found: ' + missing.map(m=>m+' is required').join('; '); return; }
  page++; render();
};
setTimeout(render, 1200); // client-rendered: the fields arrive after the button
</script></body></html>`;

export function startPortal(port = 0) {
  const state = { submitted: null };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/submitted') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { state.submitted = JSON.parse(b || '{}'); res.end('ok'); });
      return;
    }
    res.setHeader('content-type', 'text/html'); res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    resolve({ url: `http://127.0.0.1:${p}`, state, close: () => server.close() });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = await startPortal(Number(process.argv[2] ?? 4466));
  console.log(p.url);
}
