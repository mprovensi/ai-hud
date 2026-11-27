// Regras puras de segurança para caminhos de arquivo e allowlist de pastas (camada core: sem I/O).
const path = require('path');

const SECRET_FILE_RE = [
  /^\.env($|\.(?!example$|sample$|template$|dist$).+)/i,
  /\.(key|pem|p12|pfx|jks|keystore|kdbx|ovpn|mobileconfig)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pem)?$/i,
  /^\.(npmrc|pypirc|netrc|htpasswd|pgpass)$/i,
  /^(auth|credentials|secrets?)\.(json|ya?ml|toml|ini|txt|conf|env|xml)$/i,
  /(^|[._-])(secret|secrets|credential|credentials|private[_-]?key)([._-]|$)/i,
];

const SECRET_PATH_RE = [
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)data\/(config|pending)\.json$/i,
];

function isWinAbsolute(s) {
  return /^[a-zA-Z]:\\/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s);
}

// Infere a plataforma de um caminho remoto (ex.: hub Linux validando pasta Windows de um peer e vice-versa).
function detectPathPlatform(raw, fallback = process.platform) {
  const s = String(raw || '').trim().replace(/^\\\\\?\\/, '');
  if (/^[a-zA-Z]:([\\/]|$)/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s)) return 'win32';
  if (s.startsWith('/')) return 'linux';
  return fallback;
}

function normalizePath(raw, platform = process.platform) {
  let s = String(raw || '').trim();
  if (!s || /[\x00-\x1f]/.test(s)) return '';
  s = s.replace(/^\\\\\?\\/, '');
  const isWinDrive = /^[a-zA-Z]:/.test(s);
  if (platform === 'win32' && (isWinDrive || s.startsWith('\\\\'))) {
    s = s.replace(/\//g, '\\');
    // Rejeita caminhos drive-relative (ex.: "C:foo") sem barra após ':'
    if (isWinDrive && s.length > 2 && s[2] !== '\\') return '';
    if (isWinDrive && s.length === 2) s += '\\';
    s = path.win32.normalize(s);
    // Mantém barra final apenas em raiz de unidade (ex.: C:\)
    if (!/^[a-zA-Z]:\\$/.test(s)) s = s.replace(/\\+$/, '');
  } else {
    s = s.replace(/\\/g, '/');
    s = path.posix.normalize(s);
    if (s !== '/') s = s.replace(/\/+$/, '');
  }
  return s;
}

function samePath(a, b, platform = process.platform) {
  const na = normalizePath(a, platform);
  const nb = normalizePath(b, platform);
  if (!na || !nb) return false;
  return platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isWithinRoot(root, candidate, platform = process.platform) {
  const nr = normalizePath(root, platform);
  const nc = normalizePath(candidate, platform);
  if (!nr || !nc) return false;
  if (platform === 'win32' && (isWinAbsolute(nr) || isWinAbsolute(nc))) {
    if (!isWinAbsolute(nr) || !isWinAbsolute(nc)) return false;
    const r = nr.toLowerCase();
    const c = nc.toLowerCase();
    if (c === r) return true;
    const rel = path.win32.relative(r, c);
    return !!rel && rel !== '..' && !rel.startsWith('..\\') && !path.win32.isAbsolute(rel);
  }
  if (!nr.startsWith('/') || !nc.startsWith('/')) return false;
  const r = platform === 'win32' ? nr.toLowerCase() : nr;
  const c = platform === 'win32' ? nc.toLowerCase() : nc;
  if (c === r) return true;
  const rel = path.posix.relative(r, c);
  return !!rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/');
}

function isSafeRelativePath(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || s.length > 500) return false;
  if (/[\x00-\x1f]/.test(s)) return false;
  const unix = s.replace(/\\/g, '/');
  if (unix.startsWith('/') || /^[a-zA-Z]:/.test(unix)) return false;
  const parts = unix.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return false;
  }
  return true;
}

function isSecretPath(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const unix = raw.trim().replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!unix) return false;
  for (const re of SECRET_PATH_RE) {
    if (re.test(unix)) return true;
  }
  const parts = unix.split('/').filter(Boolean);
  const base = parts[parts.length - 1] || '';
  for (const re of SECRET_FILE_RE) {
    if (re.test(base)) return true;
  }
  return false;
}

function toSafeRelPath(raw, cwd, platform = process.platform) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normRaw = normalizePath(trimmed, platform);
  const normCwd = normalizePath(cwd, platform);
  if (normCwd && isWithinRoot(normCwd, normRaw, platform) && !samePath(normCwd, normRaw, platform)) {
    const sep = normCwd.includes('\\') ? '\\' : '/';
    const cut = normCwd.endsWith(sep) ? normCwd.length : normCwd.length + 1;
    const rel = normRaw.slice(cut).replace(/\\/g, '/');
    return isSafeRelativePath(rel) ? rel : null;
  }
  const rel = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  return isSafeRelativePath(rel) ? rel : null;
}

function isCwdAllowed(cwd, { allowedRoots = [], knownCwds = [], home = '', strict = false, platform = process.platform } = {}) {
  const rawTrimmed = String(cwd || '').trim();
  const norm = normalizePath(rawTrimmed, platform);
  if (!strict) return { ok: true };
  if (!rawTrimmed) return { ok: true }; // vazio = pasta pessoal padrão
  if (!norm) return { ok: false, reason: 'Caminho de pasta inválido.' };
  if (home && samePath(norm, home, platform)) return { ok: true };
  for (const known of knownCwds || []) {
    if (known && samePath(norm, known, platform)) return { ok: true };
  }
  for (const root of allowedRoots || []) {
    if (root && isWithinRoot(root, norm, platform)) return { ok: true };
  }
  return {
    ok: false,
    reason: 'Pasta fora da lista autorizada para acesso remoto (fixe o projeto no PC ou inclua em allowedRoots).',
  };
}

function resolveContainedPath(root, rel) {
  if (!root || !isSafeRelativePath(rel)) return null;
  return path.resolve(root, rel);
}

module.exports = {
  detectPathPlatform,
  normalizePath,
  samePath,
  isWithinRoot,
  isSafeRelativePath,
  isSecretPath,
  toSafeRelPath,
  isCwdAllowed,
  resolveContainedPath,
};
