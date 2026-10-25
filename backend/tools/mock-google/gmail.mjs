// ============================================================
// FAKE GOOGLE — OAuth consent + token + revoke and the few Gmail API calls
// jobpilot makes, to test "Connect Gmail" without a real Google account.
//
//   node tools/mock-google/gmail.mjs [port]      (default 4580)
//
// Point the API at it:
//   GOOGLE_CLIENT_ID=test GOOGLE_CLIENT_SECRET=test
//   GOOGLE_OAUTH_AUTH_URL=http://127.0.0.1:4580/o/oauth2/v2/auth
//   GOOGLE_OAUTH_TOKEN_URL=http://127.0.0.1:4580/token
//   GOOGLE_OAUTH_REVOKE_URL=http://127.0.0.1:4580/revoke
//   GMAIL_API_BASE=http://127.0.0.1:4580/gmail/v1
//
// The consent page approves at once and redirects back with a code. Put
// mail in the mailbox with POST /__add {from, subject, text}. Searches log
// as SEARCH lines and message reads as READ lines (what jobpilot looked at).
// ============================================================
import http from 'http';
import { randomBytes } from 'crypto';

const port = Number(process.argv[2] ?? 4580);
const ADDRESS = process.env.MOCK_GMAIL_ADDRESS ?? 'priya.sharma@gmail.com';
const codes = new Map(); // code → redirect_uri
const tokens = new Set(); // valid access tokens
const refresh = new Set();
const messages = []; // { id, internalDate, from, subject, text }

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const read = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

/** Gmail search, the parts jobpilot uses: after:<epoch> and an OR group of from:<domain> / "phrase". */
function matches(m, q) {
  const after = Number(q.match(/after:(\d+)/)?.[1] ?? 0);
  if (m.internalDate / 1000 < after) return false;
  const group = q.match(/\{([^}]*)\}/)?.[1];
  if (!group) return true;
  const terms = [...group.matchAll(/from:(\S+)|"([^"]+)"/g)];
  const hay = `${m.from} ${m.subject} ${m.text}`.toLowerCase();
  return terms.some(([, from, phrase]) => (from ? m.from.toLowerCase().includes(from.toLowerCase()) : hay.includes(phrase.toLowerCase())));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const authed = () => tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));

  if (url.pathname === '/o/oauth2/v2/auth') {
    const scope = url.searchParams.get('scope') ?? '';
    console.log(`CONSENT scope="${scope}" access_type=${url.searchParams.get('access_type')}`);
    const code = randomBytes(8).toString('hex');
    codes.set(code, url.searchParams.get('redirect_uri'));
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    back.searchParams.set('scope', scope);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    const f = new URLSearchParams(await read(req));
    const access = `at-${randomBytes(6).toString('hex')}`;
    if (f.get('grant_type') === 'authorization_code') {
      if (!codes.has(f.get('code')) || codes.get(f.get('code')) !== f.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
      codes.delete(f.get('code'));
      const rt = `rt-${randomBytes(6).toString('hex')}`;
      refresh.add(rt);
      tokens.add(access);
      return json(res, 200, { access_token: access, expires_in: 3599, refresh_token: rt, scope: 'openid email https://www.googleapis.com/auth/gmail.readonly', token_type: 'Bearer' });
    }
    if (f.get('grant_type') === 'refresh_token') {
      if (!refresh.has(f.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant' });
      tokens.add(access);
      return json(res, 200, { access_token: access, expires_in: 3599, token_type: 'Bearer' });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  if (url.pathname === '/revoke' && req.method === 'POST') {
    const t = url.searchParams.get('token');
    refresh.delete(t);
    console.log(`REVOKED ${t}`);
    return json(res, 200, {});
  }
  if (url.pathname === '/__add' && req.method === 'POST') {
    const m = JSON.parse(await read(req));
    const msg = { id: randomBytes(6).toString('hex'), internalDate: Date.now(), ...m };
    messages.push(msg);
    return json(res, 200, { id: msg.id });
  }
  if (url.pathname.startsWith('/gmail/v1/users/me/')) {
    if (!authed()) return json(res, 401, { error: { code: 401 } });
    const rest = url.pathname.slice('/gmail/v1/users/me/'.length);
    if (rest === 'profile') return json(res, 200, { emailAddress: ADDRESS, messagesTotal: messages.length });
    if (rest === 'messages') {
      const q = url.searchParams.get('q') ?? '';
      console.log(`SEARCH ${q}`);
      return json(res, 200, { messages: messages.filter((m) => matches(m, q)).map((m) => ({ id: m.id })) });
    }
    const id = rest.match(/^messages\/(\w+)$/)?.[1];
    const m = messages.find((x) => x.id === id);
    if (!m) return json(res, 404, { error: { code: 404 } });
    console.log(`READ ${m.id} ${m.subject}`);
    return json(res, 200, {
      id: m.id,
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'From', value: m.from }, { name: 'To', value: ADDRESS }, { name: 'Subject', value: m.subject }],
        parts: [{ mimeType: 'text/plain', body: { data: b64url(m.text) } }, { mimeType: 'text/html', body: { data: b64url(`<p>${m.text}</p>`) } }],
      },
    });
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`fake google on http://127.0.0.1:${port} (mailbox ${ADDRESS})`));
