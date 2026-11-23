// Redação determinística de segredos (chaves, tokens, senhas) antes de exibir previews,
// gerar handoffs ou consolidar memória no Dreaming (camada core: pura, sem I/O).

const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const KNOWN_TOKEN_RE = /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|tskey-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g;
const BEARER_RE = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi;
const URL_CRED_RE = /(\bhttps?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi;
const KV_SECRET_RE = /(^|[\s,;{"'])(["']?[A-Z0-9_.-]*(?:API_?KEY|SECRET|PASSWORD|PASSWD|AUTH_?TOKEN|ACCESS_?TOKEN|REFRESH_?TOKEN|PRIVATE_?KEY|CLIENT_?SECRET)["']?\s*[:=]\s*)(["']?)([^\s"',;}\r\n]{8,})\3/gi;

const PLACEHOLDER_RE = /^(\$\{?|\{\{|<|\[REDACTED|example|sample|changeme|your[_-]|dummy|test[_-]?key|xxx+|000+)/i;

function redactSecrets(input) {
  if (input == null) return { text: '', count: 0 };
  let text = String(input);
  let count = 0;

  text = text.replace(PEM_BLOCK_RE, () => { count++; return '[REDACTED_PRIVATE_KEY]'; });
  text = text.replace(KNOWN_TOKEN_RE, () => { count++; return '[REDACTED_TOKEN]'; });
  text = text.replace(BEARER_RE, (_, prefix) => { count++; return `${prefix}[REDACTED]`; });
  text = text.replace(URL_CRED_RE, (_, proto) => { count++; return `${proto}[REDACTED]@`; });
  text = text.replace(KV_SECRET_RE, (match, lead, assign, quote, val) => {
    if (PLACEHOLDER_RE.test(val)) return match;
    count++;
    return `${lead}${assign}${quote}[REDACTED]${quote}`;
  });

  return { text, count };
}

module.exports = { redactSecrets };
