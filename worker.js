const COOKIE = '__Host-sfl_session';
const SESSION_AGE = 60 * 60 * 24 * 7;
const textEncoder = new TextEncoder();
let schemaReady = false;

const EMPTY_WORKSPACE = {
  professors: [],
  weights: { ai: 25, cyber: 25, intersection: 35, funding: 15 },
  direction: {
    interests: ['Artificial intelligence', 'Cybersecurity', 'AI × cybersecurity'],
    text: 'Intended PhD direction: research at the intersection of artificial intelligence and cybersecurity, while keeping both fields individually relevant.'
  }
};

function json(data, status = 200, extra = {}) {
  const { cookies = [], ...otherHeaders } = extra;
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...otherHeaders
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function fail(message, status) { return json({ error: message }, status); }
function randomBytes(length) { return crypto.getRandomValues(new Uint8Array(length)); }
function hex(bytes) { return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join(''); }
function fromHex(value) { return Uint8Array.from(value.match(/../g) || [], pair => parseInt(pair, 16)); }
async function sha256(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)))); }
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations: 100000 }, key, 256);
  return hex(new Uint8Array(bits));
}

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
  );`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS auth_attempts (
    kind TEXT NOT NULL,
    attempt_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (kind, attempt_key)
  );`).run();
  schemaReady = true;
}

async function bodyJson(request, maxBytes) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new TypeError('Send JSON data.');
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new RangeError('Request is too large.');
  const raw = await request.text();
  if (textEncoder.encode(raw).length > maxBytes) throw new RangeError('Request is too large.');
  try { return JSON.parse(raw); } catch (_) { throw new TypeError('Invalid JSON data.'); }
}

function sessionCookies(token, maxAge = SESSION_AGE) {
  return [
    `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
    `__Host-sfl_preview=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None; Partitioned`
  ];
}
function sessionTokens(request) {
  const cookies = request.headers.get('cookie') || '';
  return [COOKIE, '__Host-sfl_preview'].flatMap(name => {
    const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})(?:;|$)`));
    return match ? [match[1]] : [];
  });
}
async function currentAccount(db, request) {
  for (const token of sessionTokens(request)) {
    const tokenHash = await sha256(token);
    const row = await db.prepare(`SELECT accounts.id, accounts.username
      FROM sessions JOIN accounts ON accounts.id = sessions.account_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
      .bind(tokenHash, Date.now()).first();
    if (row) return row;
  }
  return null;
}
async function createSession(db, accountId) {
  const token = hex(randomBytes(32));
  const tokenHash = await sha256(token);
  await db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, accountId, Date.now() + SESSION_AGE * 1000).run();
  return token;
}

async function attemptKey(env, request, kind, suffix = '') {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256(`${env.AUTH_RATE_SALT}|${kind}|${ip}|${suffix}`);
}
async function takeAttempt(db, kind, key, limit, windowMs) {
  const now = Date.now();
  const row = await db.prepare('SELECT window_start, count FROM auth_attempts WHERE kind = ? AND attempt_key = ?')
    .bind(kind, key).first();
  if (row && now - row.window_start < windowMs && row.count >= limit) return false;
  const start = row && now - row.window_start < windowMs ? row.window_start : now;
  const count = row && start === row.window_start ? row.count + 1 : 1;
  await db.prepare(`INSERT INTO auth_attempts (kind, attempt_key, window_start, count)
    VALUES (?, ?, ?, ?) ON CONFLICT(kind, attempt_key)
    DO UPDATE SET window_start = excluded.window_start, count = excluded.count`)
    .bind(kind, key, start, count).run();
  return true;
}

function validWorkspace(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.professors) || data.professors.length > 300) return false;
  const w = data.weights, d = data.direction;
  if (!w || !d || !Array.isArray(d.interests) || d.interests.length > 12 ||
      !d.interests.every(x => typeof x === 'string' && x.length <= 100) ||
      typeof d.text !== 'string' || d.text.length > 600) return false;
  const keys = ['ai', 'cyber', 'intersection', 'funding'];
  if (!keys.every(k => Number.isInteger(w[k]) && w[k] >= 0 && w[k] <= 100) ||
      keys.reduce((sum, k) => sum + w[k], 0) !== 100) return false;
  const ids = new Set();
  for (const p of data.professors) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 160 || ids.has(p.id) ||
      typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120 ||
      typeof p.university !== 'string' || !p.university.trim() || p.university.length > 160 ||
      !Array.isArray(p.areas) || p.areas.length > 16 || !p.areas.every(x => typeof x === 'string' && x.length <= 100) ||
      typeof p.notes !== 'string' || p.notes.length > 1200 ||
      typeof p.source !== 'string' || p.source.length > 240 ||
      !(p.profileUrl == null || p.profileUrl === '' || (typeof p.profileUrl === 'string' && p.profileUrl.length <= 1000 && /^https:\/\//i.test(p.profileUrl))) ||
      typeof p.shortlisted !== 'boolean' ||
      !keys.every(k => p[k] == null || (Number.isInteger(p[k]) && p[k] >= 0 && p[k] <= 5))) return false;
    ids.add(p.id);
  }
  return true;
}

function publicProfileUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { throw new TypeError('Enter a valid HTTPS professor profile link.'); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      url.href.length > 1000 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname) ||
      !/[a-z]{2,}$/.test(hostname.split('.').at(-1)) ||
      /(?:^|\.)(localhost|local|internal|invalid|test|example|onion)$/.test(hostname) ||
      hostname.endsWith('.chatgpt.site')) {
    throw new TypeError('Use a public HTTPS university or professor website link.');
  }
  url.hash = '';
  return url;
}
function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return ({ amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' })[entity.toLowerCase()] || ' ';
  });
}
function cleanText(value) { return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
async function fetchProfile(raw) {
  let url = publicProfileUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const response = await fetch(url.toString(), {
        redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'text/html,text/plain;q=0.9' }
      });
      if ([301,302,303,307,308].includes(response.status)) {
        const next = response.headers.get('location');
        if (!next) throw new TypeError('The profile page redirected without a destination.');
        url = publicProfileUrl(new URL(next, url).href);
        continue;
      }
      if (!response.ok) throw new TypeError('The profile page could not be opened.');
      const type = response.headers.get('content-type') || '';
      if (!/^text\/(html|plain)/i.test(type)) throw new TypeError('The link must point to a readable HTML profile page.');
      if (Number(response.headers.get('content-length') || 0) > 400000) throw new RangeError('Profile page is too large to analyze.');
      const chunks = [];
      let length = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new TypeError('The profile page returned no readable text.');
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 400000) { await reader.cancel(); throw new RangeError('Profile page is too large to analyze.'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { html: new TextDecoder().decode(bytes), url: url.toString() };
    }
    throw new TypeError('The profile page redirected too many times.');
  } finally { clearTimeout(timer); }
}

const AI_TERMS = [
  ['artificial intelligence', /\bartificial intelligence\b/i],
  ['machine learning', /\bmachine learning\b/i],
  ['deep learning', /\bdeep learning\b/i],
  ['large language models', /\blarge language models?\b|\bLLMs?\b/i],
  ['natural language processing', /\bnatural language processing\b/i],
  ['computer vision', /\bcomputer vision\b/i],
  ['reinforcement learning', /\breinforcement learning\b/i],
  ['neural networks', /\bneural networks?\b/i],
  ['generative AI', /\bgenerative (?:AI|models?)\b/i]
];
const CYBER_TERMS = [
  ['cybersecurity', /\bcyber\s*security\b/i],
  ['network security', /\bnetwork security\b/i],
  ['computer security', /\bcomputer security\b/i],
  ['software security', /\bsoftware security\b/i],
  ['information security', /\binformation security\b/i],
  ['intrusion detection', /\bintrusion detection\b/i],
  ['malware analysis', /\bmalware(?: analysis| detection)?\b/i],
  ['digital forensics', /\bdigital forensics\b/i],
  ['cryptography', /\bcryptograph\w*\b/i],
  ['vulnerability research', /\bvulnerabilit(?:y|ies)\b/i]
];
const INTERSECTION_TERMS = [
  ['AI for cybersecurity', /\b(?:AI|artificial intelligence|machine learning) (?:for|in) (?:cyber|network|computer|software|information)\s*security\b/i],
  ['adversarial machine learning', /\badversarial (?:machine learning|AI|examples?)\b/i],
  ['security of AI systems', /\b(?:security|safety) of (?:AI|machine learning|LLM) (?:systems?|models?)\b/i],
  ['privacy-preserving machine learning', /\bprivacy[-\s]preserving (?:machine learning|AI)\b/i],
  ['AI-driven intrusion detection', /\b(?:AI|ML|machine learning)[-\s](?:based|driven|enabled) intrusion detection\b/i],
  ['LLM security', /\b(?:LLM|language model) security\b/i]
];
const FUNDING_TERMS = [
  ['funded PhD position', /\b(?:fully )?funded (?:PhD|doctoral) (?:positions?|studentships?|opportunities?)\b/i],
  ['PhD funding available', /\b(?:PhD|doctoral) funding (?:is )?available\b/i],
  ['PhD studentship funding', /\b(?:funded|funding for) (?:PhD|doctoral) studentships?\b/i]
];
function matches(text, terms) { return terms.filter(([, pattern]) => pattern.test(text)).map(([label]) => label); }
function inferredRating(items) { return items.length ? Math.min(5, items.length + 1) : null; }
function analyzeProfile(html, url) {
  const h1 = cleanText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const title = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const siteName = decodeEntities(html.match(/<meta\b(?=[^>]*property=["']og:site_name["'])(?=[^>]*content=["']([^"']+)["'])[^>]*>/i)?.[1] || '');
  const text = cleanText(html
    .replace(/<\s*(script|style|noscript|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, ' ')).slice(0, 70000);
  if (text.length < 80) throw new TypeError('The page has too little readable text. You can enter the details manually.');
  const ai = matches(text, AI_TERMS);
  const cyber = matches(text, CYBER_TERMS);
  const intersection = matches(text, INTERSECTION_TERMS);
  const funding = matches(text, FUNDING_TERMS);
  const titleParts = title.split(/\s+(?:\||–|—|-|:)\s+/).map(x => x.trim());
  const nameCandidate = [h1, titleParts[0]].find(x => x.length >= 5 && x.length <= 100 &&
    !/^(home|faculty|people|staff|profile|research|about|welcome|directory|academics)$/i.test(x));
  const universityCandidate = [siteName, ...titleParts.slice(1)].find(x => /\b(university|college|institute|polytechnic)\b/i.test(x) && x.length <= 160);
  return {
    suggestions: {
      name: nameCandidate || '',
      university: universityCandidate || 'Unknown',
      areas: [...new Set([...intersection, ...ai, ...cyber])].slice(0, 8),
      ai: inferredRating(ai), cyber: inferredRating(cyber),
      intersection: intersection.length ? Math.min(5, intersection.length + 3) : null,
      funding: funding.length ? 4 : null,
      profileUrl: url, source: url.slice(0, 240),
      notes: `Suggestions from public profile, analyzed ${new Date().toISOString().slice(0,10)}. Verify research fit and current funding before applying.`
    },
    evidence: { ai, cyber, intersection, funding },
    method: 'Matched specific research and funding phrases on the linked profile. Missing phrases remain unknown; review all suggestions before saving.'
  };
}

async function handleApi(request, env, url) {
  const db = env.DB;
  if (!db || !env.AUTH_RATE_SALT) return fail('Account service is unavailable.', 503);
  await ensureSchema(db);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin !== url.origin) return fail('Invalid request origin.', 403);
  }
  const path = url.pathname;
  if (path === '/api/health' && request.method === 'GET') return json({ ok: true });

  if ((path === '/api/register' || path === '/api/login') && request.method === 'POST') {
    const input = await bodyJson(request, 2048);
    const username = String(input?.username || '').trim().toLowerCase();
    const password = input?.password;
    if (!/^[a-z0-9_-]{3,32}$/.test(username) || typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return fail('Use a 3–32 character username and a password of at least 12 characters.', 400);
    }
    const isRegister = path === '/api/register';
    const rateKey = await attemptKey(env, request, isRegister ? 'register' : 'login');
    const allowed = await takeAttempt(db, isRegister ? 'register' : 'login', rateKey, isRegister ? 5 : 25, isRegister ? 3600000 : 900000);
    if (!allowed) return fail('Too many attempts. Please try again later.', 429);
    if (isRegister) {
      const exists = await db.prepare('SELECT id FROM accounts WHERE username = ?').bind(username).first();
      if (exists) return fail('That username is already taken.', 409);
      const id = crypto.randomUUID();
      const salt = hex(randomBytes(24));
      const hash = await passwordHash(password, salt);
      try {
        await db.prepare('INSERT INTO accounts (id, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(id, username, salt, hash, Date.now()).run();
      } catch (_) { return fail('That username is already taken.', 409); }
      await db.prepare('INSERT INTO workspaces (account_id, data_json, revision) VALUES (?, ?, 0)')
        .bind(id, JSON.stringify(EMPTY_WORKSPACE)).run();
      const token = await createSession(db, id);
      return json({ username }, 201, { cookies: sessionCookies(token) });
    }
    const perUserKey = await attemptKey(env, request, 'user', username);
    if (!await takeAttempt(db, 'user', perUserKey, 10, 900000)) return fail('Too many attempts. Please try again later.', 429);
    const account = await db.prepare('SELECT id, username, password_salt, password_hash FROM accounts WHERE username = ?')
      .bind(username).first();
    // Do comparable work even when a username is unknown.
    const salt = account?.password_salt || '00'.repeat(24);
    const expected = account?.password_hash || '00'.repeat(32);
    const actual = await passwordHash(password, salt);
    if (!account || !equalBytes(fromHex(actual), fromHex(expected))) return fail('Incorrect username or password.', 401);
    await db.prepare('DELETE FROM auth_attempts WHERE kind = ? AND attempt_key = ?').bind('user', perUserKey).run();
    const token = await createSession(db, account.id);
    return json({ username: account.username }, 200, { cookies: sessionCookies(token) });
  }

  if (path === '/api/logout' && request.method === 'POST') {
    for (const token of sessionTokens(request)) {
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    }
    return json({ ok: true }, 200, { cookies: sessionCookies('', 0) });
  }

  const account = await currentAccount(db, request);
  if (!account) return fail('Sign in to continue.', 401);
  if (path === '/api/me' && request.method === 'GET') return json({ username: account.username });

  if (path === '/api/analyze-profile' && request.method === 'POST') {
    const rateKey = await attemptKey(env, request, 'profile', account.id);
    if (!await takeAttempt(db, 'profile', rateKey, 20, 3600000)) return fail('Profile analysis limit reached. Please try again later.', 429);
    const input = await bodyJson(request, 2048);
    if (typeof input?.url !== 'string') return fail('Enter a professor profile link.', 400);
    const profile = await fetchProfile(input.url);
    return json(analyzeProfile(profile.html, profile.url));
  }

  if (path === '/api/workspace' && request.method === 'GET') {
    const row = await db.prepare('SELECT data_json, revision FROM workspaces WHERE account_id = ?').bind(account.id).first();
    return json({ data: row ? JSON.parse(row.data_json) : EMPTY_WORKSPACE, revision: row?.revision ?? 0 });
  }
  if (path === '/api/workspace' && request.method === 'PUT') {
    const input = await bodyJson(request, 200000);
    if (!Number.isInteger(input?.revision) || input.revision < 0 || !validWorkspace(input?.data)) return fail('Invalid workspace data.', 400);
    const result = await db.prepare('UPDATE workspaces SET data_json = ?, revision = revision + 1 WHERE account_id = ? AND revision = ?')
      .bind(JSON.stringify(input.data), account.id, input.revision).run();
    if (!result.meta?.changes) return fail('Workspace changed elsewhere. Reload to see the latest version.', 409);
    return json({ revision: input.revision + 1 });
  }
  return fail('Endpoint not found.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await handleApi(request, env, url); }
    catch (error) {
      if (error instanceof RangeError) return fail(error.message, 413);
      if (error instanceof TypeError) return fail(error.message, 400);
      console.error('API error', String(error), String(error?.cause || ''));
      return fail('A server error occurred. Please try again.', 500);
    }
  }
};
