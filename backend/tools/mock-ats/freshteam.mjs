// ============================================================
// MOCK FRESHTEAM — a local stand-in for <company>.freshteam.com/jobs/<id>,
// with the markup of the real form (read from a live job page, nothing
// submitted there), to test the Freshteam workflow end to end.
//
//   node tools/mock-ats/freshteam.mjs [port]      (default 4570)
//   job page:  http://127.0.0.1:4570/jobs/AbC123xyz
//
// Covers: "Apply Now" (#applicant-form anchor), the résumé upload button,
// rows of <div class="form-group"><label>Email<span class="required">*</span>
// </label><input …></div> (labels not tied to inputs), a custom question,
// input#submit-button "Submit Application", confirmation.
// Not covered: the reCAPTCHA real Freshteam forms carry (the user solves it).
// ============================================================
import http from 'http';

const port = Number(process.argv[2] ?? 4570);
const submissions = [];

const group = (cls, label, name, required = true, type = 'text') =>
  `<div class='form-group ${cls}'><label class=''>${label}${required ? "<span class='required'>*<span>" : ''}</label><input size="25" class="form-control" type="${type}" name="applicant[lead_attributes[${name}]]" id="applicant_lead_attributes[${name}]" /></div>`;

const PAGE = (err = '') => `<!doctype html><html><head><title>Backend Engineer - Mock Org</title></head><body>
<h1>Backend Engineer</h1><p>Pune, Maharashtra, India · Full Time</p>
<a href="#applicant-form" class="btn btn-primary">Apply Now</a>
<div id="applicant-form">${err ? `<div class="err" role="alert">${err}</div>` : ''}
<form name="applicant_form" enctype="multipart/form-data" action="/jobs/AbC123xyz/applicants" method="post">
  <div class="resume-upload"><label class="btn btn-primary" id="uploadValue"> Apply With Resume <span class="required">*</span> </label>
  <input type="file" class="upload-file" id="uploadFile" name="applicant[lead_attributes[resumes_attributes][][content]]" title="Apply With Resume"></div>
  ${group('first_name', 'First Name', 'first_name')}
  ${group('middle_name', 'Middle Name', 'middle_name', false)}
  ${group('last_name', 'Last Name', 'last_name')}
  ${group('', 'Email', 'email')}
  ${group('', 'Mobile', 'mobile', false)}
  <div class='form-group'><label class=''>Total years of experience<span class='required'>*<span></label><input class="form-control" type="text" name="applicant[custom_field_values][total_exp]" /></div>
  <div class='form-group'><label class=''>Are you willing to relocate to Pune?<span class='required'>*<span></label><select class="form-control" name="applicant[custom_field_values][relocate]"><option value="">Select</option><option>Yes</option><option>No</option></select></div>
  <input type="submit" name="commit" value="Submit Application" class="btn btn-primary btn-lg" id="submit-button">
</form></div></body></html>`;

function parseMultipart(raw) {
  const out = {};
  for (const part of raw.split(/--[-\w]+/)) {
    const name = part.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const file = part.match(/filename="([^"]*)"/)?.[1];
    out[name] = file ?? part.split(/\r\n\r\n/).slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
  }
  return out;
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/__submissions') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(submissions)); }
  if (req.method === 'GET' && url.pathname === '/jobs/AbC123xyz') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE()); }
  if (req.method === 'POST' && url.pathname === '/jobs/AbC123xyz/applicants') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const f = parseMultipart(Buffer.concat(chunks).toString('latin1'));
      const need = {
        'applicant[lead_attributes[resumes_attributes][][content]]': 'Resume', 'applicant[lead_attributes[first_name]]': 'First Name',
        'applicant[lead_attributes[last_name]]': 'Last Name', 'applicant[lead_attributes[email]]': 'Email',
        'applicant[custom_field_values][total_exp]': 'Total years of experience', 'applicant[custom_field_values][relocate]': 'Relocate',
      };
      const missing = Object.entries(need).filter(([k]) => !f[k]).map(([, l]) => l);
      res.writeHead(200, { 'content-type': 'text/html' });
      if (missing.length) return res.end(PAGE(`Please fill: ${missing.join(', ')}`));
      submissions.push(f);
      console.log(`SUBMITTED ${JSON.stringify(f)}`);
      res.end('<!doctype html><html><head><title>Thank you</title></head><body><h2>Thank you for applying</h2><p>We have received your application for Backend Engineer.</p></body></html>');
    });
    return;
  }
  res.writeHead(404).end('not found');
}).listen(port, '127.0.0.1', () => console.log(`mock freshteam on http://127.0.0.1:${port}/jobs/AbC123xyz`));
