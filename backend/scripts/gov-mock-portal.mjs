#!/usr/bin/env node
/**
 * A mock recruitment portal that behaves like the real ones (SSC, RRB, UPSC…):
 * image captcha on login and registration, email/mobile OTP behind
 * "Generate OTP" buttons, a multi-page application with "Save & Next",
 * photo and signature uploads with a stated KB range that the SERVER
 * enforces, a preview page and a "Final Submit". It validates everything, so
 * a flow that passes here really did fill, upload and submit correctly.
 *
 * Used by verify-gov-flow.ts; also runnable alone: node scripts/gov-mock-portal.mjs 4455
 */
import http from 'http';
import { randomInt } from 'crypto';

export function startPortal(port = 0) {
  const state = {
    captcha: 'K7P2Q',
    emailOtp: null,
    mobileOtp: null,
    accounts: new Map(), // regno → password
    loggedIn: false,
    page1: null,
    page2: null,
    uploads: {},
    requireAadhaar: true,
    aadhaarOtp: null,
    aadhaarVerified: false,
    aadhaarUsed: null,
    submitted: null,
    log: [],
  };

  const layout = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:640px;margin:24px auto}label{display:block;margin:10px 0 2px}input,select{padding:6px;width:100%;box-sizing:border-box}.err{color:#b00;border:1px solid #b00;padding:6px}.hint{color:#555;font-size:12px}</style></head><body>
<h2>${title}</h2>${body}</body></html>`;

  const captchaSvg = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="44"><rect width="140" height="44" fill="#eef"/><text x="14" y="32" font-size="28" font-family="monospace" letter-spacing="4" fill="#223">${state.captcha}</text></svg>`;
  const captchaBlock = `<label for="captcha">Captcha *</label><img id="captchaImage" class="captcha-img" alt="captcha" src="/captcha.svg?${Date.now()}"><input id="captcha" name="captcha" type="text" placeholder="Enter captcha">`;

  const parseMultipart = (buf, boundary) => {
    const fields = {};
    const files = {};
    for (const part of buf.toString('binary').split(`--${boundary}`).slice(1, -1)) {
      const [head, ...rest] = part.split('\r\n\r\n');
      const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
      const name = head.match(/name="([^"]+)"/)?.[1];
      const filename = head.match(/filename="([^"]*)"/)?.[1];
      if (!name) continue;
      if (filename !== undefined) files[name] = { filename, size: Buffer.byteLength(body, 'binary') };
      else fields[name] = Buffer.from(body, 'binary').toString('utf8');
    }
    return { fields, files };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const send = (html, status = 200, type = 'text/html') => {
        res.writeHead(status, { 'content-type': type });
        res.end(html);
      };
      const redirect = (to) => {
        res.writeHead(302, { location: to });
        res.end();
      };
      const form = () => Object.fromEntries(new URLSearchParams(raw.toString()));
      state.log.push(`${req.method} ${url.pathname}`);

      if (url.pathname === '/__state') return send(JSON.stringify({ ...state, accounts: [...state.accounts] }), 200, 'application/json');
      if (url.pathname === '/captcha.svg') return send(captchaSvg(), 200, 'image/svg+xml');

      // ── OTP endpoints (what "Generate OTP" calls) ──
      if (url.pathname === '/otp/email') {
        state.emailOtp = String(randomInt(100000, 999999));
        return send('sent');
      }
      if (url.pathname === '/otp/mobile') {
        state.mobileOtp = String(randomInt(100000, 999999));
        return send('sent');
      }

      // ── Registration ──
      if (url.pathname === '/register' && req.method === 'GET') {
        return send(
          layout(
            'Create an Account',
            `<form method="post" action="/register">
<label>Full Name *</label><input name="fullName">
<label>Father's Name *</label><input name="father">
<label>Mother's Name *</label><input name="mother">
<label>Date Of Birth *</label><input name="dob" placeholder="DD/MM/YYYY">
<label>Email Address *</label><input name="email" type="email">
<label>Email OTP *</label><input name="emailOtp"><button type="button" onclick="fetch('/otp/email')">Generate Email OTP</button>
<label>Mobile Number *</label><input name="mobile">
<label>Mobile OTP *</label><input name="mobileOtp"><button type="button" onclick="fetch('/otp/mobile')">Generate Mobile OTP</button>
<label>Password *</label><input name="password" type="password">
${captchaBlock}
<p><button type="submit">Create An Account</button></p></form>`,
          ),
        );
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        const f = form();
        const errs = [];
        if (f.captcha !== state.captcha) errs.push('Invalid captcha');
        if (!state.emailOtp || f.emailOtp !== state.emailOtp) errs.push('Invalid email OTP');
        if (!state.mobileOtp || f.mobileOtp !== state.mobileOtp) errs.push('Invalid mobile OTP');
        if (!f.password || f.password.length < 8) errs.push('Password too short');
        if (errs.length) return send(layout('Create an Account', `<p class="err">${errs.join('; ')}</p><a href="/register">Back</a>`));
        const regno = `MOCK${randomInt(10000, 99999)}`;
        state.accounts.set(regno, f.password);
        state.registered = { ...f, regno };
        return send(layout('Registration complete', `<p>Registration successful. Your Registration Number is <b>${regno}</b></p>`));
      }

      // ── Login ──
      if (url.pathname === '/login' && req.method === 'GET') {
        return send(
          layout(
            'Candidate Login',
            `<form method="post" action="/login">
<label for="regno">Registration Number</label><input id="regno" name="regno" type="text" placeholder="Registration Number">
<label for="password">Password</label><input id="password" name="password" type="password" placeholder="Password">
${captchaBlock}
<p><button type="submit">Login</button></p></form>`,
          ),
        );
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        const f = form();
        state.log.push('LOGIN ' + JSON.stringify({ r: f.regno, pwLen: (f.password || '').length, cap: f.captcha, known: state.accounts.has(f.regno) }));
        if (f.captcha !== state.captcha) return send(layout('Candidate Login', '<p class="err">Invalid captcha</p><a href="/login">Back</a>'));
        if (state.accounts.get(f.regno) !== f.password) return send(layout('Candidate Login', '<p class="err">Wrong registration number or password</p><a href="/login">Back</a>'));
        state.loggedIn = true;
        return redirect('/apply/1');
      }

      // ── Aadhaar verification gate (like RRB / OTR) ──
      if (url.pathname === '/otp/aadhaar') {
        state.aadhaarOtp = String(randomInt(100000, 999999));
        return send('sent');
      }
      if (url.pathname === '/verify' && req.method === 'GET') {
        return send(
          layout(
            'Aadhaar Verification',
            `<form method="post" action="/verify">
<label>Aadhaar Number / Virtual ID *</label><input name="aadhaar">
<label><input type="checkbox" name="consent" value="1" style="width:auto"> I consent to authenticate with Aadhaar *</label>
<p><button type="button" onclick="fetch('/otp/aadhaar')">Generate Aadhaar OTP</button></p>
<label>Aadhaar OTP *</label><input name="aadhaarOtp">
<p><button type="submit">Verify &amp; Continue</button></p></form>`,
          ),
        );
      }
      if (url.pathname === '/verify' && req.method === 'POST') {
        const f = form();
        if (!/^\d{12}$/.test(f.aadhaar ?? '') || f.consent !== '1' || !state.aadhaarOtp || f.aadhaarOtp !== state.aadhaarOtp)
          return send(layout('Aadhaar Verification', '<p class="err">Aadhaar verification failed</p><a href="/verify">Back</a>'));
        state.aadhaarVerified = true;
        state.aadhaarUsed = f.aadhaar;
        return redirect('/apply/1');
      }

      // ── Application wizard ──
      if (url.pathname.startsWith('/apply') && !state.loggedIn) return redirect('/login');
      if (url.pathname.startsWith('/apply') && state.requireAadhaar && !state.aadhaarVerified) return redirect('/verify');
      if (url.pathname === '/apply/1' && req.method === 'GET') {
        return send(
          layout(
            'Personal Details',
            `<form method="post" action="/apply/1">
<label>Candidate's Name *</label><input name="name">
<label>Father's Name *</label><input name="father">
<label>Mother's Name *</label><input name="mother">
<label>Date of Birth (DD/MM/YYYY) *</label><input name="dob">
<label>Gender *</label><select name="gender"><option value="">--Select--</option><option>Male</option><option>Female</option><option>Transgender</option></select>
<label>Category *</label><select name="category"><option value="">--Select--</option><option>UR (General)</option><option>OBC (Non-Creamy Layer)</option><option>EWS</option><option>SC</option><option>ST</option></select>
<label>Nationality *</label><select name="nationality"><option value="">--Select--</option><option>Indian</option><option>Other</option></select>
<p><button type="submit">Save &amp; Next</button></p></form>`,
          ),
        );
      }
      if (url.pathname === '/apply/1' && req.method === 'POST') {
        const f = form();
        const missing = ['name', 'father', 'mother', 'dob', 'gender', 'category', 'nationality'].filter((k) => !f[k]);
        if (missing.length || !/^\d{2}\/\d{2}\/\d{4}$/.test(f.dob)) return send(layout('Personal Details', `<p class="err">Missing or invalid: ${missing.join(', ') || 'dob'}</p><a href="/apply/1">Back</a>`));
        state.page1 = f;
        return redirect('/apply/2');
      }
      if (url.pathname === '/apply/2' && req.method === 'GET') {
        return send(
          layout(
            'Education and Documents',
            `<form method="post" action="/apply/2" enctype="multipart/form-data">
<label>10th Percentage *</label><input name="tenthPct">
<label>10th Year of Passing *</label><input name="tenthYear">
<label>10th Board *</label><input name="tenthBoard">
<label>Passport Size Photograph *</label><input type="file" name="photo"><div class="hint">JPG only, size 20 KB to 50 KB, 200 x 230 pixels</div>
<label>Signature *</label><input type="file" name="signature"><div class="hint">JPG only, size 10 KB to 30 KB, 140 x 60 pixels</div>
<p><button type="submit">Save &amp; Next</button></p></form>`,
          ),
        );
      }
      if (url.pathname === '/apply/2' && req.method === 'POST') {
        const boundary = req.headers['content-type']?.match(/boundary=(.+)$/)?.[1];
        const { fields, files } = parseMultipart(raw, boundary);
        const kb = (n) => n / 1024;
        const errs = [];
        for (const k of ['tenthPct', 'tenthYear', 'tenthBoard']) if (!fields[k]) errs.push(`${k} required`);
        const ph = files.photo?.size ?? 0;
        const sg = files.signature?.size ?? 0;
        if (kb(ph) < 20 || kb(ph) > 50) errs.push(`Photograph must be 20-50 KB (got ${kb(ph).toFixed(1)} KB)`);
        if (kb(sg) < 10 || kb(sg) > 30) errs.push(`Signature must be 10-30 KB (got ${kb(sg).toFixed(1)} KB)`);
        if (errs.length) state.log.push('ERR2 ' + errs.join(';'));
        if (errs.length) return send(layout('Education and Documents', `<p class="err">${errs.join('; ')}</p><a href="/apply/2">Back</a>`));
        state.page2 = fields;
        state.uploads = { photoKB: kb(ph), signatureKB: kb(sg) };
        return redirect('/apply/3');
      }
      if (url.pathname === '/apply/3' && req.method === 'GET') {
        const p1 = state.page1 ?? {};
        const p2 = state.page2 ?? {};
        return send(
          layout(
            'Preview',
            `<table border="1" cellpadding="4">${Object.entries({ ...p1, ...p2 }).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
<form method="post" action="/apply/3"><label><input type="checkbox" name="declare" value="1" style="width:auto"> I declare that the information given is true *</label>
<p><button type="submit">Final Submit</button></p></form>`,
          ),
        );
      }
      if (url.pathname === '/apply/3' && req.method === 'POST') {
        const f = form();
        if (f.declare !== '1') return send(layout('Preview', '<p class="err">Please accept the declaration</p><a href="/apply/3">Back</a>'));
        state.submitted = { at: new Date().toISOString(), ...state.page1, ...state.page2, ...state.uploads };
        return send(layout('Acknowledgement', '<p>Your application has been submitted. Application Number: <b>MOCK-2026-0042</b></p>'));
      }

      send(layout('Mock Recruitment Portal', '<a href="/register">Register</a> | <a href="/login">Login</a>'), 200);
    });
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, state, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = await startPortal(Number(process.argv[2] ?? 4455));
  console.log(`mock portal on ${p.url}`);
}
