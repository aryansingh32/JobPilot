// ============================================================
// MOCK ZOHO RECRUIT — a local stand-in for <company>.zohorecruit.in career
// pages, with the markup of the real form (read from a live careers page,
// nothing submitted there), to test the Zoho workflow end to end.
//
//   node tools/mock-ats/zoho.mjs [port]      (default 4569)
//   job page:  http://127.0.0.1:4569/jobs/Careers/1001/backend-engineer?source=CareerSite
//
// Covers: cookie banner ("Decline non-essential"), "I'm interested" opening
// the form, inputs named rec-form_<id> labelled by <label id="crc-label-…">,
// required rows marked "mandatoryField", City / State lookups inside
// <lyte-autocomplete id="<id>">, phone with a country-code picker, Résumé and
// Cover Letter uploads (both required), an image CAPTCHA (its text is printed
// as CAPTCHA lines), confirmation. Submissions print as SUBMITTED.
// ============================================================
import http from 'http';

const port = Number(process.argv[2] ?? 4569);
const submissions = [];
let captcha = '';

const row = (id, label, control, mandatory = true) => `
<div class="cxRow ${mandatory ? 'mandatoryField' : ''}">
  <label id="crc-label-rec-form_${id}" class="crc-label"><span class="crc-label-text"><span>${label}</span></span></label>
  <div class="cxElementValue">${control}</div>
</div>`;
const text = (id, extra = '') => `<lyte-input><input type="text" name="rec-form_${id}" autocomplete="off" ${extra}></lyte-input>`;
const lookup = (id) => `<div class="cxLookupComponent mandatoryField"><lyte-autocomplete id="${id}"><input type="text" id="inputId" autocomplete="off"></lyte-autocomplete></div>`;

const PAGE = () => `<!doctype html><html><head><title>Backend Engineer | Mock Labs Careers</title>
<style>.cxRow{margin:10px 0}label{display:block}.err{color:#b00}#form{display:none}</style></head><body>
<div id="cookie" role="dialog">We use cookies. <lyte-button><button onclick="document.getElementById('cookie').remove()">Decline non-essential</button></lyte-button>
<lyte-button><button onclick="document.getElementById('cookie').remove()">Accept all</button></lyte-button></div>
<h1>Backend Engineer</h1><p>Bengaluru, Karnataka, India · Work Experience: 3-6 years</p>
<button id="interested" onclick="document.getElementById('form').style.display='block';this.remove()">I'm interested</button>
<form id="form" method="post" enctype="multipart/form-data" action="/jobs/Careers/1001/apply">
  <h3>Basic Info</h3>
  ${row(3149, 'First Name', text(3149))}
  ${row(3151, 'Last Name', text(3151))}
  ${row(3155, 'Email', text(3155))}
  ${row(3161, 'Mobile', `<div class="cxDropdownInputGroup cxGroupMandatoryField"><lyte-dropdown lt-prop-selected="IN"><input type="text" id="inputId" value="+91" readonly class="readonly"></lyte-dropdown>${text(3161)}</div>`)}
  <h3>Address Information</h3>
  ${row(3171, 'City', lookup(3171))}
  ${row(3175, 'State', lookup(3175))}
  ${row(3177, 'Country', text(3177))}
  <h3>Professional Details</h3>
  ${row(3199, 'Current Salary', text(3199))}
  ${row(3197, 'Expected Salary', text(3197))}
  ${row(3181, 'Current Employer', text(3181), false)}
  ${row(17197, 'Resume', '<input type="file" name="rec-form_17197_file">')}
  ${row(17201, 'Cover Letter', '<input type="file" name="rec-form_17201_file">')}
  <div class="captcha"><img id="captchaImg" src="/captcha.svg" alt="captcha" width="140" height="44">
  ${row(9999, 'Enter the characters shown in the image', text(9999, 'id="captchaInput"'))}</div>
  <button type="submit">Submit Application</button>
</form></body></html>`;

const SVG = () => {
  captcha = Math.random().toString(36).slice(2, 7).toUpperCase();
  console.log(`CAPTCHA ${captcha}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="44"><rect width="140" height="44" fill="#eee"/><text x="18" y="30" font-size="24" font-family="monospace" fill="#333">${captcha}</text></svg>`;
};

const REQUIRED = { rec_form_3149: 'First Name', rec_form_3151: 'Last Name', rec_form_3155: 'Email', rec_form_3161: 'Mobile', rec_form_3177: 'Country', rec_form_3199: 'Current Salary', rec_form_3197: 'Expected Salary', rec_form_17197_file: 'Resume', rec_form_17201_file: 'Cover Letter' };

function parseMultipart(raw) {
  const out = {};
  for (const part of raw.split(/--[-\w]+/)) {
    const name = part.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const file = part.match(/filename="([^"]*)"/)?.[1];
    out[name.replace(/-/g, '_')] = file ?? part.split(/\r\n\r\n/).slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
  }
  return out;
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/captcha.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(SVG()); }
  if (url.pathname === '/__submissions') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(submissions)); }
  if (req.method === 'GET' && url.pathname.startsWith('/jobs/Careers/1001')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE()); }
  if (req.method === 'POST' && url.pathname === '/jobs/Careers/1001/apply') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const f = parseMultipart(Buffer.concat(chunks).toString('latin1'));
      const missing = Object.entries(REQUIRED).filter(([k]) => !f[k]).map(([, l]) => l);
      res.writeHead(200, { 'content-type': 'text/html' });
      if ((f.rec_form_9999 ?? '').toUpperCase() !== captcha) return res.end(PAGE().replace('<form', '<div class="err" role="alert">The characters you entered are incorrect.</div><form').replace('id="form"', 'id="form" style="display:block"'));
      if (missing.length) return res.end(PAGE().replace('<form', `<div class="err" role="alert">Please fill: ${missing.join(', ')}</div><form`).replace('id="form"', 'id="form" style="display:block"'));
      const answers = Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'rec_form_9999'));
      submissions.push(answers);
      console.log(`SUBMITTED ${JSON.stringify(answers)}`);
      res.end('<!doctype html><html><head><title>Thank you</title></head><body><h2>Thank you for applying!</h2><p>Your application has been submitted successfully.</p></body></html>');
    });
    return;
  }
  res.writeHead(404).end('not found');
}).listen(port, '127.0.0.1', () => console.log(`mock zoho on http://127.0.0.1:${port}/jobs/Careers/1001/backend-engineer?source=CareerSite`));
