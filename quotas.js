// Cotas ao vivo, perguntando aos próprios CLIs (sem gastar turno de modelo).
// Técnica do agent-hud-open: Claude via control_request get_usage, Codex via app-server.
const { spawn } = require('child_process');
const path = require('path');
const { HOME } = require('./lib');

const CLAUDE = path.join(HOME, '.local', 'bin', 'claude.exe');
const CODEX = path.join(HOME, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');

// Inicia o CLI, manda as mensagens JSON-lines e resolve com a primeira resposta que `pick` aceitar
function ask(exe, args, env, messages, pick, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: { ...process.env, ...env }, windowsHide: true, cwd: __dirname });
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
  if (!p.rate_limits_available || !p.rate_limits) return { plan: p.subscription_type || null, windows: {} };
  const ms = (w) => w && w.utilization != null && win(w.utilization, Date.parse(w.resets_at));
  return { plan: p.subscription_type, windows: { five_hour: ms(p.rate_limits.five_hour), seven_day: ms(p.rate_limits.seven_day) } };
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
