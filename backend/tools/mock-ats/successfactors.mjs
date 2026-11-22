// ============================================================
// MOCK SAP SUCCESSFACTORS — a local stand-in for a company career site on
// SuccessFactors Recruiting (careers.<company>.com + career55.sapsf.eu), with
// the markup of the real pages (read from careers.wipro.com, nothing
// submitted there), to test the SuccessFactors workflow without creating
// accounts or applying at real companies.
//
//   node tools/mock-ats/successfactors.mjs [port]      (default 4568)
//   job page:  http://127.0.0.1:4568/job/Bengaluru-Backend-Engineer/1001/
//
// Covers: cookie banner (no decline button, like Wipro's), Apply now →
// Apply Now, sign in / create an account (retyped email, 8–18 character
// password rules, name, country code + phone, country, privacy statement
// dialog), optional email verification (MOCK_VERIFY=1: the link is mailed
// through jobpilot's inbound webhook when INBOUND_URL + INBOUND_EMAIL_SECRET
// are set), one application page with an Apply button, confirmation.
// ============================================================
import http from 'http';
import { randomBytes } from 'crypto';

const port = Number(process.argv[2] ?? 4568);
const VERIFY = process.env.MOCK_VERIFY === '1';
const accounts = new Map(); // email → { password, verified, token, name }
const sessions = new Map(); // sid → email
const submissions = [];
const COMPANY = 'mockcoP2';

const page = (title, body) => `<!doctype html><html><head><title>${title}</title>
<style>label{display:block;margin-top:10px}.err{color:#b00}#dlg{display:none;border:1px solid #888;padding:12px}</style></head><body>
<div id="cookieBanner">We use cookies to offer you the best possible website experience.
<button id="cookie-bannershow">Modify Cookie Preferences</button><button id="cookie-accept" onclick="this.parentElement.remove()">Accept All Cookies</button></div>
${body}</body></html>`;

const JOB = page('Backend Engineer Job Details | Mock Co', `
<h1>Backend Engineer</h1><p>City: Bengaluru · State/Province: Karnataka</p>
<div id="unifyApplyNowButtonContainer" class="dropdown">
  <button id="unifyApplyNowTopButton" class="unify-apply-now" onclick="document.getElementById('unifyApplyNowButtonListDropDown').style.display='block'">Apply now</button>
  <ul id="unifyApplyNowButtonListDropDown" role="menu" style="display:none">
    <li><a role="menuitem" href="#" id="applyOption--manual" class="applyOption" aria-label="Apply Now" onclick="location.href='/career?company=${COMPANY}&career_ns=login&jobId=1001';return false">Apply Now</a></li>
    <li><a role="menuitem" href="#" id="applyOption--linkedin" class="applyOption">Apply with LinkedIn</a></li>
  </ul>
</div><p>Job Description: 3-6 years building APIs.</p>`);

const LOGIN = (msg = '') => page('Career Opportunities: Sign In', `
<h2>Sign In</h2>${msg ? `<div class="err" role="alert">${msg}</div>` : ''}
<form method="post" action="/career?company=${COMPANY}&career_ns=login&jobId=1001">
<label for="username">Email Address</label><input id="username" name="username" type="text">
<label for="password">Password</label><input id="password" name="password" type="password">
<button type="submit">Sign In</button></form>
<a href="#">Forgot your password?</a> <a href="/career?company=${COMPANY}&career_ns=create&jobId=1001">Create an account</a>`);

const COUNTRIES = [['Afghanistan', '93'], ['India', '91'], ['Singapore', '65'], ['United Kingdom', '44'], ['United States', '1']];
const CREATE = (msg = '') => page('Career Opportunities: Create an Account', `
<h2>Career Opportunities: Create an Account</h2>
<p>Already a registered user? <a href="/career?company=${COMPANY}&career_ns=login&jobId=1001">Please sign in</a></p>
${msg ? `<div class="err" role="alert">${msg}</div>` : ''}
<form method="post" id="f" action="/career?company=${COMPANY}&career_ns=create&jobId=1001">
<label title="Required" for="fbclc_userName">Email Address: *</label><input id="fbclc_userName" name="fbclc_userName" type="text" maxlength="99">
<label title="Required" for="fbclc_emailConf">Retype Email Address: *</label><input id="fbclc_emailConf" name="fbclc_emailConf" type="text" maxlength="99">
<label title="Required" for="fbclc_pwd">Choose Password: *</label><input id="fbclc_pwd" name="fbclc_pwd" type="password" maxlength="99">
<label title="Required" for="fbclc_pwdConf">Retype Password: *</label><input id="fbclc_pwdConf" name="fbclc_pwdConf" type="password" maxlength="99">
<label title="Required" for="fbclc_fName">First Name: *</label><input id="fbclc_fName" name="fbclc_fName" type="text" maxlength="40">
<label title="Required" for="fbclc_lName">Last Name: *</label><input id="fbclc_lName" name="fbclc_lName" type="text" maxlength="40">
<label title="Required" for="fbclc_ituCode">Country/Region Code:*</label><select id="fbclc_ituCode" name="fbclc_ituCode"><option value="">- Select -</option>${COUNTRIES.map(([n, c]) => `<option value="${c}">${n} (+${c})</option>`).join('')}</select>
<label title="Required" for="fbclc_phoneNumber">Phone Number:*</label><input id="fbclc_phoneNumber" name="fbclc_phoneNumber" type="text">
<label for="fbclc_country">Country/Region of Residence:*</label><select id="fbclc_country" name="fbclc_country"><option value="">- Select -</option>${COUNTRIES.map(([n]) => `<option>${n}</option>`).join('')}</select>
<input type="hidden" id="privacy" name="privacy" value="">
<label>Terms of Use:*</label><a id="dataPrivacyId" href="#" onclick="document.getElementById('dlg').style.display='block';return false">Read and accept the data privacy statement.</a>
<div id="dlg" role="dialog"><p>Data privacy statement…</p><button type="button" onclick="document.getElementById('privacy').value='yes';document.getElementById('dlg').style.display='none'">Accept</button><button type="button">Decline</button></div>
<button id="fbclc_createAccountButton" name="fbclc_createAccountButton" type="submit">Create Account</button></form>`);

const APPLICATION = (email) => page('Career Opportunities: Backend Engineer (1001)', `
<h2>Backend Engineer — Application</h2>
<form method="post" enctype="multipart/form-data" action="/career?company=${COMPANY}&career_ns=job_application&jobId=1001">
<label for="f1">First Name *</label><input id="f1" name="firstName" required>
<label for="f2">Last Name *</label><input id="f2" name="lastName" required>
<label for="f3">Email *</label><input id="f3" name="email" type="email" value="${email}" required>
<label for="f4">Cell Phone *</label><input id="f4" name="cellPhone" type="tel" required>
<label for="f5">Resume *</label><input id="f5" name="resume" type="file" required>
<label for="f6">Highest Qualification *</label><select id="f6" name="qualification" required><option value="">No Selection</option><option>B.E / B.Tech</option><option>M.E / M.Tech</option><option>MCA</option><option>Other</option></select>
<label for="f7">Total Experience (in years) *</label><input id="f7" name="totalExperience" required>
<label for="f8">Notice Period *</label><select id="f8" name="noticePeriod" required><option value="">No Selection</option><option>Immediate</option><option>30 Days</option><option>60 Days</option><option>90 Days</option></select>
<button type="submit">Apply</button></form>`);

const DONE = page('Career Opportunities: Thank you', '<h2>Thank you for applying!</h2><p>Your application for Backend Engineer (1001) has been received.</p>');
const CHECK_EMAIL = page('Career Opportunities: Verify', '<h2>Almost there</h2><p>Please check your email to verify your account, then sign in.</p>');

const form = (req) => new Promise((r) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('latin1');
    const ct = req.headers['content-type'] ?? '';
    if (ct.startsWith('multipart/')) {
      const out = {};
      for (const part of raw.split(/--[-\w]+/)) {
        const name = part.match(/name="([^"]+)"/)?.[1];
        if (!name) continue;
        const file = part.match(/filename="([^"]*)"/)?.[1];
        out[name] = file ?? part.split(/\r\n\r\n/).slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      }
      return r(out);
    }
    r(Object.fromEntries(new URLSearchParams(raw)));
  });
});
const send = (res, html, headers = {}) => { res.writeHead(200, { 'content-type': 'text/html', ...headers }); res.end(html); };
const redirect = (res, to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
const sid = (req) => sessions.get((req.headers.cookie ?? '').match(/sfsess=(\w+)/)?.[1] ?? '');
const startSession = (email) => { const id = randomBytes(8).toString('hex'); sessions.set(id, email); return `sfsess=${id}; Path=/`; };
const APP_URL = `/career?company=${COMPANY}&career_ns=job_application&jobId=1001`;

async function mailLink(to, link) {
  console.log(`VERIFY_LINK ${to} ${link}`);
  const url = process.env.INBOUND_URL, secret = process.env.INBOUND_EMAIL_SECRET;
  if (!url || !secret) return;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inbound-secret': secret },
    body: JSON.stringify({
      to, from: 'careers@successfactors.eu', fromName: 'Mock Co Recruiting',
      subject: 'Mock Co: please verify your email address',
      text: `Thank you for creating an account.\n\nPlease verify your email address by clicking the link below:\n${link}\n\nMock Co Talent Acquisition`,
    }),
  }).catch((e) => ({ status: e.message }));
  console.log(`MAILED ${to} → ${r.status}`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ns = url.searchParams.get('career_ns');
  if (req.method === 'GET' && url.pathname.startsWith('/job/')) return send(res, JOB);
  if (url.pathname === '/__submissions') return send(res, JSON.stringify(submissions), { 'content-type': 'application/json' });
  if (url.pathname === '/verify') {
    const acct = [...accounts.values()].find((a) => a.token === url.searchParams.get('token'));
    if (!acct) return send(res, page('Verify', '<p>This link is not valid.</p>'));
    acct.verified = true;
    console.log(`VERIFIED ${acct.email}`);
    return send(res, page('Verified', '<p>Your email address is verified. You can now sign in.</p>'));
  }
  if (url.pathname !== '/career') return redirect(res, '/');

  if (ns === 'login') {
    if (sid(req)) return redirect(res, APP_URL);
    if (req.method === 'GET') return send(res, LOGIN());
    const f = await form(req);
    const acct = accounts.get(f.username);
    if (!acct || acct.password !== f.password) return send(res, LOGIN('Invalid username or password. Login credentials are case sensitive.'));
    if (!acct.verified) return send(res, LOGIN('Please verify your account first — check your email for the verification link.'));
    console.log(`SIGNED_IN ${f.username}`);
    return redirect(res, APP_URL, { 'set-cookie': startSession(f.username) });
  }
  if (ns === 'create') {
    if (req.method === 'GET') return send(res, CREATE());
    const f = await form(req);
    const p = f.fbclc_pwd ?? '';
    const missing = ['fbclc_userName', 'fbclc_emailConf', 'fbclc_pwd', 'fbclc_pwdConf', 'fbclc_fName', 'fbclc_lName', 'fbclc_ituCode', 'fbclc_phoneNumber', 'fbclc_country'].filter((k) => !f[k]);
    if (missing.length) return send(res, CREATE(`Please complete the required fields: ${missing.join(', ')}`));
    if (f.fbclc_userName !== f.fbclc_emailConf) return send(res, CREATE('The email addresses do not match.'));
    if (p !== f.fbclc_pwdConf) return send(res, CREATE('The passwords do not match.'));
    if (p.length < 8 || p.length > 18 || !/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/[\d\W_]/.test(p) || /\s/.test(p)) return send(res, CREATE('Password must be 8-18 characters with upper and lower case letters and a number or punctuation character.'));
    if (f.privacy !== 'yes') return send(res, CREATE('You must read and accept the data privacy statement.'));
    if (accounts.has(f.fbclc_userName)) return send(res, CREATE('An account with this email address already exists.'));
    const token = randomBytes(12).toString('hex');
    accounts.set(f.fbclc_userName, { email: f.fbclc_userName, password: p, verified: !VERIFY, token, phone: `+${f.fbclc_ituCode} ${f.fbclc_phoneNumber}`, country: f.fbclc_country, name: `${f.fbclc_fName} ${f.fbclc_lName}` });
    console.log(`CREATED ${f.fbclc_userName} phone=+${f.fbclc_ituCode} ${f.fbclc_phoneNumber} country=${f.fbclc_country} pwlen=${p.length}`);
    if (VERIFY) {
      await mailLink(f.fbclc_userName, `http://${req.headers.host}/verify?token=${token}`);
      return send(res, CHECK_EMAIL);
    }
    return redirect(res, APP_URL, { 'set-cookie': startSession(f.fbclc_userName) });
  }
  if (ns === 'job_application') {
    const email = sid(req);
    if (!email) return redirect(res, `/career?company=${COMPANY}&career_ns=login&jobId=1001`);
    if (req.method === 'GET') return send(res, APPLICATION(email));
    const f = await form(req);
    submissions.push({ email, answers: f });
    console.log(`SUBMITTED ${JSON.stringify({ email, answers: f })}`);
    return send(res, DONE);
  }
  redirect(res, '/');
}).listen(port, '127.0.0.1', () => console.log(`mock successfactors on http://127.0.0.1:${port}/job/Bengaluru-Backend-Engineer/1001/${VERIFY ? ' (verify email)' : ''}`));
