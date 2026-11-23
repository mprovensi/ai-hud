// Cota ao vivo do Gemini:
//   1. Antigravity CLI (`agy --print /usage --output-format json`): método atual recomendado pelo Google
//      para contas individuais, sem gastar turno nem tokens; traz janelas de 5h e 7 dias.
//   2. Fallback Gemini CLI OAuth (`~/.gemini/oauth_creds.json` + Code Assist API, somente leitura),
//      caso o `agy` não esteja instalado neste PC.
const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { ROOT } = require('../../infra/paths');
const { readJson } = require('../../infra/store');

const HOME = os.homedir();
const WIN = process.platform === 'win32';
const GEMINI_HOME = process.env.GEMINI_HOME || path.join(HOME, '.gemini');
const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Token renovado do OAuth legado mantido apenas em memória para não alterar arquivos do CLI
let memToken = { refreshToken: '', accessToken: '', expiresAt: 0 };

function findAgy() {
  if (process.env.AI_HUD_AGY) return process.env.AI_HUD_AGY;
  const file = WIN ? 'agy.exe' : 'agy';
  const known = WIN
    ? [
        path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'agy', 'bin'),
        path.join(HOME, '.gemini', 'antigravity-cli', 'bin'),
      ]
    : [
        path.join(HOME, '.local', 'bin'),
        path.join(HOME, '.gemini', 'antigravity-cli', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ];
  const dirs = known.concat((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  for (const dir of dirs) {
    const p = path.join(dir, file);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

const usedPct = (rem) => Math.round((1 - Math.max(0, Math.min(1, rem))) * 1000) / 10;

// Converte a saída JSON de `agy --print /usage --output-format json` em { plan, windows }
function parseAgyUsage(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('resposta inválida do Antigravity CLI');
  if (payload.status && payload.status !== 'SUCCESS') throw new Error(payload.error || 'erro ao ler cota do Antigravity');
  const groups = payload.command && payload.command.data && payload.command.data.groups;
  if (!Array.isArray(groups) || !groups.length) return { plan: 'Antigravity', windows: {} };
  const group = groups.find((g) => /^gemini models$/i.test(String(g.name || '')))
    || groups.find((g) => /gemini/i.test(String(g.name || '')) && Array.isArray(g.buckets) && g.buckets.some((b) => b.window === '5h'))
    || groups[0];
  const buckets = Array.isArray(group.buckets) ? group.buckets : [];
  const windows = {};
  for (const b of buckets) {
    if (!b || typeof b.remaining_fraction !== 'number') continue;
    const w = { used: usedPct(b.remaining_fraction), resetsAt: b.reset_time ? Date.parse(b.reset_time) || 0 : 0 };
    if (b.window === '5h' || /5h/i.test(String(b.id || ''))) windows.five_hour = w;
    else if (b.window === 'weekly' || /weekly/i.test(String(b.id || ''))) windows.seven_day = w;
  }
  return { plan: 'Antigravity', windows };
}

function runAgyUsage(exe, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(exe, ['--print', '/usage', '--output-format', 'json', '--print-timeout', '25s'],
      { windowsHide: true, cwd: ROOT, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || '').trim().split(/\r?\n/)[0] || 'erro ao executar agy';
          const e = new Error(msg);
          e.code = err.code;
          e.soft = err.killed || /timeout|timed out/i.test(msg);
          return reject(e);
        }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('resposta JSON inválida do agy')); }
      });
  });
}

async function agyQuota({ exe = findAgy(), exec = runAgyUsage } = {}) {
  if (!exe) return null;
  const payload = await exec(exe);
  return parseAgyUsage(payload);
}

// ---- Fallback legado: Gemini CLI OAuth (~/.gemini/oauth_creds.json) --------

function postHttps(url, headers, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('tempo esgotado')); });
    req.write(payload);
    req.end();
  });
}

// Procura client_id/client_secret do OAuth instalado na cópia local do @google/gemini-cli-core
function extractOAuthClient(oauth2File) {
  try {
    const src = fs.readFileSync(oauth2File, 'utf8');
    const id = /OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/.exec(src);
    const secret = /OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/.exec(src);
    if (id && secret) return { clientId: id[1], clientSecret: secret[1] };
  } catch {}
  return null;
}

function findOAuthClient() {
  if (process.env.AI_HUD_GEMINI_CLIENT_ID && process.env.AI_HUD_GEMINI_CLIENT_SECRET) {
    return { clientId: process.env.AI_HUD_GEMINI_CLIENT_ID, clientSecret: process.env.AI_HUD_GEMINI_CLIENT_SECRET };
  }
  const rel = path.join('@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js');
  const roots = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
    path.join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules'),
    path.join(HOME, '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  ];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const bin of ['gemini', 'gemini.cmd', 'gemini.ps1']) {
      const p = path.join(dir, bin);
      try {
        const real = fs.realpathSync(p);
        roots.push(path.join(path.dirname(real), '..', 'node_modules'));
        roots.push(path.join(path.dirname(real), 'node_modules'));
      } catch {}
    }
  }
  for (const r of roots) {
    for (const candidate of [
      path.join(r, rel),
      path.join(r, '@google', 'gemini-cli', 'node_modules', rel),
    ]) {
      const creds = extractOAuthClient(candidate);
      if (creds) return creds;
    }
  }
  return null;
}

function pickBucket(list) {
  if (!list.length) return null;
  return list.slice().sort((a, b) => (b.used - a.used) || ((a.resetsAt || Infinity) - (b.resetsAt || Infinity)))[0];
}

function parseGeminiBuckets(buckets) {
  if (!Array.isArray(buckets) || !buckets.length) return {};
  const parsed = [];
  for (const b of buckets) {
    if (!b || typeof b !== 'object' || typeof b.remainingFraction !== 'number') continue;
    const used = usedPct(b.remainingFraction);
    const resetsAt = b.resetTime ? Date.parse(b.resetTime) || 0 : 0;
    parsed.push({ used, resetsAt, modelId: String(b.modelId || ''), tokenType: String(b.tokenType || '') });
  }
  if (!parsed.length) return {};
  const pro = pickBucket(parsed.filter((b) => /\bpro\b|pro[-_]/i.test(b.modelId)));
  const flash = pickBucket(parsed.filter((b) => /\bflash\b|flash[-_]/i.test(b.modelId)));
  const toWin = (b) => ({ used: b.used, resetsAt: b.resetsAt, modelId: b.modelId });
  const windows = {};
  if (pro) windows.pro = toWin(pro);
  if (flash) windows.flash = toWin(flash);
  if (!windows.pro && !windows.flash) {
    const any = pickBucket(parsed);
    if (any) windows.daily = toWin(any);
  }
  return windows;
}

function authType(root) {
  const settings = readJson(path.join(root, 'settings.json'), {});
  return String((settings.security && settings.security.auth && settings.security.auth.selectedType) || settings.selectedAuthType || '');
}

async function resolveAccessToken(creds, { request, now, clientCreds }) {
  const freshInFile = creds.access_token && (!creds.expiry_date || creds.expiry_date > now() + 60e3);
  if (freshInFile) return creds.access_token;
  if (creds.refresh_token && memToken.refreshToken === creds.refresh_token && memToken.accessToken && memToken.expiresAt > now() + 60e3) {
    return memToken.accessToken;
  }
  if (!creds.refresh_token) throw new Error('token OAuth do Gemini expirado');
  const client = clientCreds !== undefined ? clientCreds : findOAuthClient();
  if (!client) {
    const err = new Error('sessão OAuth do Gemini expirada (instale o Antigravity CLI `agy` ou renove o login)');
    err.soft = true;
    throw err;
  }
  const form = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();
  const res = await request(OAUTH_TOKEN_URL, { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
  if (res.status < 200 || res.status >= 300) throw new Error(`renovação OAuth do Gemini falhou (HTTP ${res.status})`);
  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('resposta inválida ao renovar token do Gemini'); }
  if (!data.access_token) throw new Error('resposta sem access_token do Gemini');
  memToken = {
    refreshToken: creds.refresh_token,
    accessToken: data.access_token,
    expiresAt: now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return memToken.accessToken;
}

async function geminiOAuthQuota({ root = GEMINI_HOME, request = postHttps, now = () => Date.now(), clientCreds } = {}) {
  const mode = authType(root);
  if (/api[-_]?key|vertex/i.test(mode)) return { plan: null, windows: {} };
  const creds = readJson(path.join(root, 'oauth_creds.json'), null);
  if (!creds || (!creds.access_token && !creds.refresh_token)) return { plan: null, windows: {} };

  const token = await resolveAccessToken(creds, { request, now, clientCreds });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let project = '';
  let plan = null;
  try {
    const r1 = await request(`${CODE_ASSIST_BASE}:loadCodeAssist`, headers, {
      metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' },
    });
    if (r1.status === 401) {
      memToken = { refreshToken: '', accessToken: '', expiresAt: 0 };
      throw new Error('sessão OAuth do Gemini expirada');
    }
    if (r1.status >= 200 && r1.status < 300) {
      const info = JSON.parse(r1.body);
      project = String(info.cloudaicompanionProject || '');
      const tier = info.paidTier || info.currentTier;
      plan = (tier && (tier.name || tier.id)) || null;
    }
  } catch (e) {
    if (/expirada/.test(e.message)) throw e;
  }

  const r2 = await request(`${CODE_ASSIST_BASE}:retrieveUserQuota`, headers, project ? { project } : {});
  if (r2.status === 401) {
    memToken = { refreshToken: '', accessToken: '', expiresAt: 0 };
    throw new Error('sessão OAuth do Gemini expirada');
  }
  if (r2.status < 200 || r2.status >= 300) {
    const e = new Error(`erro ao ler cota do Gemini (HTTP ${r2.status})`);
    e.soft = r2.status === 429 || r2.status >= 500;
    throw e;
  }
  let payload;
  try { payload = JSON.parse(r2.body); } catch { throw new Error('resposta inválida da cota do Gemini'); }
  const windows = parseGeminiBuckets(payload.buckets);
  return { plan, windows };
}

async function geminiQuota({ root = GEMINI_HOME, request = postHttps, now = () => Date.now(), clientCreds, agyExe, execAgy } = {}) {
  const exe = agyExe !== undefined ? agyExe : findAgy();
  if (exe) {
    try {
      const res = await agyQuota({ exe, exec: execAgy || runAgyUsage });
      if (res) return res;
    } catch (e) {
      // Se o agy não foi encontrado, cai para o fallback OAuth; outros erros do agy são reportados
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return geminiOAuthQuota({ root, request, now, clientCreds });
}

module.exports = { geminiQuota, agyQuota, parseAgyUsage, parseGeminiBuckets, extractOAuthClient, findAgy };
