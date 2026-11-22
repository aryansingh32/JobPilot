// ============================================================
// MOCK ORACLE RECRUITING CLOUD — a local stand-in for a company's
// *.oraclecloud.com Candidate Experience site, with the same markup the real
// apply flow uses (read from a live KPMG site, nothing submitted there), to
// test the Oracle workflow without applying at real companies.
//
//   node tools/mock-ats/oracle.mjs [port]      (default 4567)
//   job page:  http://127.0.0.1:4567/hcmUI/CandidateExperience/en/sites/CX/job/1001
//
// Covers: APPLY NOW → email + terms (with Oracle's honeypot field) → a
// 6-box verification code → three steps (contact, résumé + questions,
// e-signature next to Submit) → confirmation.
//
// The code is "emailed" through jobpilot's own inbound webhook when
// INBOUND_URL + INBOUND_EMAIL_SECRET are set (so the inbox fills it in), and
// always printed as CODE lines. MOCK_SMS=1 asks for a phone number first and
// "texts" the code instead (printed only). Submissions print as SUBMITTED.
// ============================================================
import http from 'http';

const port = Number(process.argv[2] ?? 4567);
const SMS = process.env.MOCK_SMS === '1';
const codes = new Map(); // email → code
const submissions = [];

const BASE = '/hcmUI/CandidateExperience/en/sites/CX/job/1001';
const head = (title) => `<!doctype html><html><head><title>${title} - Mock Corp Careers</title>
<meta property="og:site_name" content="Mock Corp Careers">
<style>label{display:block;margin-top:10px}.input-row__label--required:after{content:" *"}
.legal-disclaimer-container{cursor:pointer}.err{color:#b00}</style></head><body>`;

const JOB = `${head('Backend Engineer')}
<h1>Backend Engineer</h1><p>Bengaluru, Karnataka, India</p>
<button class="button apply-now-button theme-color-1 apply-now-button--apply-now" onclick="location.href='${BASE}/apply/email'">APPLY NOW</button>
<div>JOB DESCRIPTION — 3-6 years of experience with Node.js and PostgreSQL.</div></body></html>`;

// The apply flow is client-side, like Oracle's.
const APPLY = `${head('Backend Engineer')}<main id="root"></main>
<script>
const SMS = ${SMS};
const root = document.getElementById('root');
const state = { email: '', step: 0, answers: {} };
const api = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json().then(j => ({ ok: r.ok, ...j })));
const err = (m) => root.insertAdjacentHTML('afterbegin', '<div class="err" role="alert">' + m + '</div>');
const clearErr = () => root.querySelectorAll('.err').forEach(e => e.remove());
const nextBtn = (title) => '<button type="submit" class="button apply-flow-pagination__button theme-color-1" aria-label="' + title + '" title="' + title + '">' + title.toUpperCase() + '</button>';

function emailScreen() {
  root.innerHTML = '<h2>Job application form</h2><p>You don\\'t need to have an account</p>'
    + '<label class="input-row__label input-row__label--required" for="primary-email-0">Email Address</label>'
    + '<input id="primary-email-0" name="primary-email" type="email" class="input-row__control" autocomplete="email">'
    + '<label class="input-row__label" for="honey-pot-1">honeypot</label><input id="honey-pot-1" name="honey-pot" class="input-row__control">'
    + '<label class="input-row legal-disclaimer-container"><span role="checkbox" aria-checked="false" id="terms" class="apply-flow-input-checkbox__button"></span> I agree with the terms and conditions</label>'
    + '<button type="button" data-qa="emailVerificationCancelButton" title="Cancel">CANCEL</button>' + nextBtn('Next');
  const terms = document.getElementById('terms');
  document.querySelector('.legal-disclaimer-container').onclick = () => terms.setAttribute('aria-checked', terms.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  document.querySelector('button[title=Next]').onclick = async () => {
    clearErr();
    const email = document.getElementById('primary-email-0').value.trim();
    if (!/@/.test(email)) return err('Enter a valid email address.');
    if (terms.getAttribute('aria-checked') !== 'true') return err('You must agree with the terms and conditions.');
    if (document.getElementById('honey-pot-1').value) return err('We could not process your request.');
    state.email = email;
    if (SMS) return phoneScreen();
    const r = await api('/api/send-code', { email });
    if (!r.ok) return err(r.error);
    codeScreen('We sent a verification code to ' + email + '. Enter it below.');
  };
}
function phoneScreen() {
  root.innerHTML = '<h2>Confirm your identity</h2><label for="phone">Mobile Phone Number</label><input id="phone" name="phoneNumber" type="tel">' + nextBtn('Next');
  document.querySelector('button[title=Next]').onclick = async () => {
    const phone = document.getElementById('phone').value.replace(/\\D/g, '');
    if (phone.length < 8) return err('Enter a valid phone number.');
    await api('/api/send-code', { email: state.email, phone });
    codeScreen('We sent a code by text message to +91 ••••• ' + phone.slice(-4) + '.');
  };
}
function codeScreen(msg) {
  root.innerHTML = '<h2>Confirm your identity</h2><p>' + msg + '</p><div>'
    + [1,2,3,4,5,6].map(i => '<input id="pin-code-' + i + '" maxlength="1" inputmode="numeric" aria-label="Digit ' + i + '" style="width:2em">').join('')
    + '</div><button type="button" title="Verify">VERIFY</button>';
  document.querySelector('button[title=Verify]').onclick = async () => {
    clearErr();
    const code = [1,2,3,4,5,6].map(i => document.getElementById('pin-code-' + i).value).join('');
    const r = await api('/api/verify', { email: state.email, code });
    if (!r.ok) return err('The verification code is invalid. Try again.');
    render();
  };
}
const STEPS = [
  { title: 'Contact Information', fields: [
    ['lastName', 'Last Name', 'text'], ['firstName', 'First Name', 'text'],
    ['email', 'Email', 'email'], ['phone', 'Phone Number', 'tel'], ['city', 'City', 'text'],
  ]},
  { title: 'Resume and Application Questions', fields: [
    ['resume', 'Upload Resume', 'file'],
    ['q_exp', 'Total years of experience', 'text'],
    ['q_notice', 'What is your notice period?', 'select', ['Immediate', '15 days', '30 days', '60 days', '90 days']],
  ]},
  { title: 'E-Signature', fields: [['fullName', 'Full Name', 'text']], last: true },
];
function field([id, label, type, opts]) {
  const control = type === 'select'
    ? '<select id="' + id + '" aria-required="true"><option value="">Select a value</option>' + opts.map(o => '<option>' + o + '</option>').join('') + '</select>'
    : '<input id="' + id + '" type="' + type + '" aria-required="true">';
  return '<label class="input-row__label input-row__label--required" for="' + id + '">' + label + '</label>' + control;
}
function render() {
  const s = STEPS[state.step];
  root.innerHTML = '<h2>' + s.title + '</h2>' + s.fields.map(field).join('')
    + (s.last ? '<p>By typing your name you sign this application.</p>' + nextBtn('Submit') : nextBtn('Next'));
  if (state.step === 0) document.getElementById('email').value = state.email;
  document.querySelector('button[title=' + (s.last ? 'Submit' : 'Next') + ']').onclick = async () => {
    clearErr();
    const missing = [];
    for (const [id, label, type] of s.fields) {
      const el = document.getElementById(id);
      const v = type === 'file' ? (el.files[0] && el.files[0].name) : el.value.trim();
      if (!v) missing.push(label);
      state.answers[label] = v;
    }
    if (missing.length) return missing.forEach(m => err(m + ' is required.'));
    if (!s.last) { state.step++; return render(); }
    await api('/api/submit', { email: state.email, answers: state.answers });
    root.innerHTML = '<h2>Thank you for applying!</h2><p>Your application for Backend Engineer was submitted. Reference: ORC-' + Date.now().toString().slice(-6) + '</p>';
  };
}
emailScreen();
</script></body></html>`;

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : {})); });

/** Deliver the code like a real email: to jobpilot's inbound webhook when configured. */
async function mailCode(to, code) {
  console.log(`CODE ${to} ${code}`);
  const url = process.env.INBOUND_URL, secret = process.env.INBOUND_EMAIL_SECRET;
  if (!url || !secret) return;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inbound-secret': secret },
    body: JSON.stringify({
      to, from: 'no-reply@mockcorp.fa.oraclecloud.com', fromName: 'Mock Corp Careers',
      subject: 'Mock Corp: Confirm your identity',
      text: `Hello,\n\nUse this verification code to continue your job application: ${code}\n\nThe code expires in 10 minutes.`,
    }),
  }).catch((e) => ({ status: e.message }));
  console.log(`MAILED ${to} → ${r.status}`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === BASE) return res.end(JOB);
  if (req.method === 'GET' && url.pathname.startsWith(`${BASE}/apply`)) return res.end(APPLY);
  if (req.method === 'GET' && url.pathname === '/__submissions') return json(res, 200, submissions);
  if (req.method === 'POST' && url.pathname === '/api/send-code') {
    const { email, phone } = await body(req);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    codes.set(email, code);
    if (phone) console.log(`SMS +91${phone} ${code}`);
    else await mailCode(email, code);
    return json(res, 200, { sent: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/verify') {
    const { email, code } = await body(req);
    if (codes.get(email) !== code) return json(res, 400, { error: 'invalid code' });
    codes.delete(email);
    console.log(`VERIFIED ${email}`);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/submit') {
    const s = await body(req);
    submissions.push(s);
    console.log(`SUBMITTED ${JSON.stringify(s)}`);
    return json(res, 200, { ok: true });
  }
  res.writeHead(404).end('not found');
}).listen(port, '127.0.0.1', () => console.log(`mock oracle on http://127.0.0.1:${port}${BASE}${SMS ? ' (sms)' : ''}`));
