// Cotas ao vivo, perguntando aos próprios CLIs (sem gastar turno de modelo).
// Técnica do agent-hud-open: Claude via control_request get_usage, Codex via app-server.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { HOME } = require('./lib');

// Acha o executável: variável de ambiente, locais conhecidos de cada sistema, depois o PATH.
// No Windows só .exe: spawn sem shell não executa .cmd.
const WIN = process.platform === 'win32';
function findExe(name, envVar, known) {
  if (process.env[envVar]) return process.env[envVar];
  const file = WIN ? `${name}.exe` : name;
  const dirs = known.concat((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  for (const dir of dirs) {
    const p = path.join(dir, file);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return file; // deixa o spawn tentar; se não existir, a cota mostra o erro
}

const CLAUDE = findExe('claude', 'AI_HUD_CLAUDE', [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local')]);
const CODEX = findExe('codex', 'AI_HUD_CODEX', WIN
  ? [path.join(HOME, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin')]
  : [path.join(HOME, '.local', 'bin'), '/usr/local/bin']);

// Inicia o CLI, manda as mensagens JSON-lines e resolve com a primeira resposta que `pick` aceitar
function ask(exe, args, env, messages, pick, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: { ...process.env, ...env }, windowsHide: true, cwd: path.join(__dirname, '..') });
    let buf = '', done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('tempo esgotado')), timeoutMs);
    child.on('error', (e) => finish(e));
    child.on('exit', () => finish(new Error('o processo terminou sem responder')));
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const reply = pick(msg, (m) => child.stdin.write(JSON.stringify(m) + '\n'));
        if (reply !== undefined) finish(null, reply);
      }
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

const win = (used, resetsAt) => ({ used, resetsAt });

async function claudeQuota() {
  const r = await ask(CLAUDE,
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', '{"disableAllHooks":true}'],
    { CLAUDE_CODE_ENTRYPOINT: 'ai-hud' },
    [{ type: 'control_request', request_id: 'ai-hud', request: { subtype: 'get_usage', skip_behaviors: true } }],
    (m) => (m.type === 'control_response' ? m.response : undefined));
  if (r.subtype === 'error') throw new Error(r.error || 'erro do Claude Code');
  const p = r.response || {};
  if (!p.rate_limits_available) return { plan: p.subscription_type || null, windows: {} }; // login sem cota (API key)
  const ms = (w) => w && w.utilization != null && win(w.utilization, Date.parse(w.resets_at));
  const windows = p.rate_limits ? { five_hour: ms(p.rate_limits.five_hour), seven_day: ms(p.rate_limits.seven_day) } : {};
  // Plano com cota, mas sem números: o Claude Code não conseguiu ler (ex.: recusou por consultas
  // frequentes). É leitura falha, não "sem cota": o servidor mantém a leitura anterior.
  if (!windows.five_hour && !windows.seven_day) {
    const e = new Error('leitura sem números (consultas frequentes?)');
    e.soft = true;
    throw e;
  }
  return { plan: p.subscription_type, windows };
}

async function codexQuota() {
  const r = await ask(CODEX, ['app-server', '--listen', 'stdio://'], {},
    [{ id: 1, method: 'initialize', params: { clientInfo: { name: 'ai_hud', title: 'AI HUD', version: '0.1.0' } } }],
    (m, send) => {
      if (m.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }); }
      if (m.id === 2) return m;
    }, 30000);
  if (r.error) throw new Error(r.error.message || 'erro do Codex');
  const l = r.result.rateLimits || {};
  const ms = (w) => w && win(w.usedPercent, w.resetsAt * 1000);
  const resets = r.result.rateLimitResetCredits;
  return { plan: l.planType, windows: { five_hour: ms(l.primary), seven_day: ms(l.secondary) },
    resetCredits: resets ? resets.availableCount : 0 };
}

module.exports = { claudeQuota, codexQuota, CODEX };
