// ============================================================
// MOCK WORKDAY — a local stand-in for a company's *.myworkdayjobs.com site,
// built with Workday's own data-automation-id hooks, to test the Workday
// apply workflow without creating accounts or applying at real companies.
//
//   node tools/mock-ats/workday.mjs [port]      (default 4566)
//   job page:  http://127.0.0.1:4566/en-US/Mock/job/Backend-Engineer_JR100
//
// Covers: Apply → Apply Manually, create account / sign in (with the
// click_filter overlay Workday puts over its buttons), four client-side
// pages with required-field validation, a review page whose button reads
// "Submit", and a confirmation. Accounts live in memory; submissions are
// printed as SUBMITTED {...} lines and listed at /__submissions.
// ============================================================
import http from 'http';

const port = Number(process.argv[2] ?? 4566);
const accounts = new Map(); // email → password
const submissions = [];

const JOB = `<!doctype html><html><head><title>Backend Engineer - Mock Corp</title></head><body>
<h2 data-automation-id="jobPostingHeader">Backend Engineer</h2>
<p>Mock Corp · San Francisco, CA · Hybrid</p>
<a href="#" data-automation-id="adventureButton" onclick="document.getElementById('m').style.display='block';return false">Apply</a>
<div id="m" style="display:none" role="dialog">
  <a href="#" data-automation-id="autofillWithResume">Autofill with Resume</a>
  <a href="/en-US/Mock/job/Backend-Engineer_JR100/apply/applyManually" data-automation-id="applyManually">Apply Manually</a>
</div></body></html>`;

// The application is one page of client-side JS, like Workday's.
const APP = `<!doctype html><html><head><title>Apply - Backend Engineer - Mock Corp</title>
<style>.btn{position:relative;display:inline-block;margin-top:12px}
.click_filter{position:absolute;inset:0}
label{display:block;margin-top:10px} [data-automation-id=errorMessage]{color:#b00}</style></head>
<body><div data-automation-id="progressBarActiveStep" id="step"></div><main id="root"></main>
<div id="footer"></div>
<script>
const state = { email: '', page: 0, answers: {} };
const PAGES = [
  { title: 'My Information', fields: [
    ['legalNameSection_firstName', 'Given Name(s)', 'text'],
    ['legalNameSection_lastName', 'Family Name', 'text'],
    ['email', 'Email Address', 'email'],
    ['phone-number', 'Phone Number', 'tel'],
    ['addressSection_city', 'City', 'text'],
    ['source', 'How Did You Hear About Us?', 'select', ['LinkedIn', 'Company Website', 'Referral', 'Other']],
  ]},
  { title: 'My Experience', fields: [
    ['file-upload-input-ref', 'Upload a file (Resume)', 'file'],
    ['linkedinQuestion', 'LinkedIn', 'url', null, true],
  ]},
  { title: 'Application Questions', fields: [
    ['q_authorized', 'Are you legally authorized to work in the country in which this job is located?', 'select', ['Yes', 'No']],
    ['q_sponsorship', 'Will you now or in the future require sponsorship for employment visa status?', 'select', ['Yes', 'No']],
    ['q_salary', 'What are your salary expectations for this role?', 'text'],
  ]},
  { title: 'Voluntary Disclosures', fields: [
    ['gender', 'Please select your gender', 'select', ['Male', 'Female', 'I do not wish to answer']],
    ['agreementCheckbox', 'I have read and consent to the terms and conditions', 'checkbox'],
  ]},
];
const root = document.getElementById('root'), footer = document.getElementById('footer'), step = document.getElementById('step');
const btn = (id, text) => '<span class="btn"><button data-automation-id="' + id + '">' + text + '</button><div class="click_filter" data-automation-id="click_filter"></div></span>';
const field = ([id, label, type, opts, optional]) => {
  const req = optional ? '' : ' *';
  const input = type === 'select'
    ? '<select id="' + id + '" data-automation-id="' + id + '"' + (optional ? '' : ' aria-required="true"') + '><option value="">Select One</option>' + opts.map(o => '<option>' + o + '</option>').join('') + '</select>'
    : '<input id="' + id + '" data-automation-id="' + id + '" type="' + type + '"' + (optional ? '' : ' aria-required="true"') + '>';
  return type === 'checkbox'
    ? '<label for="' + id + '">' + input + ' ' + label + req + '</label>'
    : '<label for="' + id + '">' + label + req + '</label>' + input;
};
// Buttons sit under the overlay: a plain click lands on the overlay, as on Workday.
const onFilter = (id, fn) => footer.querySelector('[data-automation-id=' + id + ']').parentElement.querySelector('.click_filter').onclick = fn;
const onBtn = (id, fn) => { const b = document.querySelector('[data-automation-id=' + id + ']'); b.onclick = fn; const f = b.parentElement.querySelector('.click_filter'); if (f) f.onclick = fn; };
const err = (msg) => { root.insertAdjacentHTML('afterbegin', '<div data-automation-id="errorMessage" role="alert">' + msg + '</div>'); };
const api = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json().then(j => ({ ok: r.ok, ...j })));

function signIn() {
  step.textContent = ''; footer.innerHTML = '';
  root.innerHTML = '<h2>Sign In</h2>' + field(['email', 'Email Address', 'email']) + field(['password', 'Password', 'password'])
    + btn('signInSubmitButton', 'Sign In') + '<p><a href="#" data-automation-id="createAccountLink">Create Account</a></p>';
  document.querySelector('[data-automation-id=createAccountLink]').onclick = (e) => { e.preventDefault(); createAccount(); };
  onBtn('signInSubmitButton', async () => {
    const r = await api('/api/signin', { email: email.value, password: password.value });
    if (!r.ok) return err(r.error);
    state.email = email.value; render();
  });
}
function createAccount() {
  root.innerHTML = '<h2>Create Account</h2>' + field(['email', 'Email Address', 'email']) + field(['password', 'Password', 'password'])
    + field(['verifyPassword', 'Verify New Password', 'password'])
    + '<label><input type="checkbox" data-automation-id="createAccountCheckbox"> I agree to the privacy terms *</label>'
    + btn('createAccountSubmitButton', 'Create Account') + '<p><a href="#" data-automation-id="signInLink">Sign In</a></p>';
  document.querySelector('[data-automation-id=signInLink]').onclick = (e) => { e.preventDefault(); signIn(); };
  onBtn('createAccountSubmitButton', async () => {
    if (password.value !== verifyPassword.value) return err('Passwords do not match');
    if (!document.querySelector('[data-automation-id=createAccountCheckbox]').checked) return err('Accept the terms to continue');
    if (password.value.length < 8 || !/[A-Z]/.test(password.value) || !/[0-9]/.test(password.value) || !/[^A-Za-z0-9]/.test(password.value)) return err('Password does not meet the requirements');
    const r = await api('/api/create', { email: email.value, password: password.value });
    if (!r.ok) return err(r.error);
    state.email = email.value; render();
  });
}
function render() {
  if (state.page >= PAGES.length) return review();
  const p = PAGES[state.page];
  step.textContent = p.title;
  root.innerHTML = '<h2 data-automation-id="pageHeader">' + p.title + '</h2>' + p.fields.map(field).join('');
  footer.innerHTML = btn('bottom-navigation-next-button', 'Save and Continue');
  onFilter('bottom-navigation-next-button', () => {
    root.querySelectorAll('[data-automation-id=errorMessage]').forEach(e => e.remove());
    const missing = [];
    for (const [id, label, type, , optional] of p.fields) {
      const el = document.getElementById(id);
      const v = type === 'checkbox' ? el.checked : type === 'file' ? el.files.length : el.value.trim();
      if (!v && !optional) missing.push(label);
      state.answers[label] = type === 'checkbox' ? el.checked : type === 'file' ? (el.files[0] && el.files[0].name) : el.value;
    }
    if (missing.length) return missing.forEach(m => err('Error: ' + m + ' is required'));
    state.page++; render();
  });
}
function review() {
  step.textContent = 'Review';
  root.innerHTML = '<h2 data-automation-id="pageHeader">Review</h2>' + Object.entries(state.answers).map(([k, v]) => '<p>' + k + ': <b>' + v + '</b></p>').join('');
  footer.innerHTML = btn('bottom-navigation-next-button', 'Submit');
  onFilter('bottom-navigation-next-button', async () => {
    await api('/api/submit', { email: state.email, answers: state.answers });
    step.textContent = ''; footer.innerHTML = '';
    root.innerHTML = '<h2>Application Submitted</h2><p>Thank you for applying! Reference: MOCK-' + Date.now().toString().slice(-6) + '</p>';
  });
}
signIn();
</script></body></html>`;

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const b = JSON.parse(raw || '{}');
      if (url.pathname === '/api/create') {
        if (accounts.has(b.email)) return json(res, 409, { error: 'An account already exists with this email address.' });
        accounts.set(b.email, b.password);
        console.log('ACCOUNT_CREATED', b.email);
        return json(res, 200, {});
      }
      if (url.pathname === '/api/signin') {
        if (accounts.get(b.email) !== b.password) return json(res, 401, { error: 'Wrong email address or password.' });
        console.log('SIGNED_IN', b.email);
        return json(res, 200, {});
      }
      if (url.pathname === '/api/submit') {
        submissions.push(b);
        console.log('SUBMITTED', JSON.stringify(b));
        return json(res, 200, {});
      }
      json(res, 404, {});
    });
    return;
  }
  if (url.pathname === '/__submissions') return json(res, 200, { submissions, accounts: [...accounts.keys()] });
  // Pre-create an account (to test "already exists" → ask for the password).
  if (url.pathname === '/__account') {
    accounts.set(url.searchParams.get('email'), url.searchParams.get('password'));
    return json(res, 200, { ok: true });
  }
  res.setHeader('content-type', 'text/html');
  res.end(url.pathname.endsWith('/applyManually') ? APP : JOB);
}).listen(port, '127.0.0.1', () => console.log(`mock workday on http://127.0.0.1:${port}/en-US/Mock/job/Backend-Engineer_JR100`));
