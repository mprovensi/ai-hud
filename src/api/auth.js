// Acesso ao HUD: só redes locais/Tailscale, PIN trocado por token e bloqueio de tentativas.

// Só loopback, redes privadas e Tailscale (100.64.0.0/10)
function allowed(addr) {
  const ip = String(addr || '').replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const [a, b] = ip.split('.').map(Number);
  return (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || /^fd/i.test(ip);
}

// PIN para digitar no aparelho; troca pelo token. 5 erros bloqueiam o IP por 5 min,
// e 20 erros de qualquer origem bloqueiam o login por 15 min (contra quem troca de IP)
function createLoginGuard(now = () => Date.now()) {
  const failures = new Map();
  let globalFailures = [];
  return {
    blocked(ip) {
      const f = failures.get(ip);
      globalFailures = globalFailures.filter((t) => now() - t < 15 * 60e3);
      return (f && f.count >= 5 && now() - f.at < 5 * 60e3) || globalFailures.length >= 20;
    },
    failed(ip) {
      const f = failures.get(ip);
      failures.set(ip, { count: f && now() - f.at < 5 * 60e3 ? f.count + 1 : 1, at: now() });
      globalFailures.push(now());
    },
    passed(ip) { failures.delete(ip); },
  };
}

const loginPage = (msg) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>AI HUD</title>
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="AI HUD">
<meta name="mobile-web-app-capable" content="yes"><meta name="theme-color" content="#121211">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" sizes="76x76" href="/icon-76.png"><link rel="apple-touch-icon" sizes="152x152" href="/icon-152.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png"><link rel="icon" type="image/png" href="/icon-192.png">
<style>body{background:#121211;color:#ecece8;font:16px -apple-system,Roboto,sans-serif;text-align:center;padding:60px 16px}
input{font-size:28px;width:230px;text-align:center;letter-spacing:6px;padding:8px;border-radius:8px;border:1px solid #3a3a36;background:#1c1c1a;color:#ecece8}
button{font-size:17px;margin-top:16px;padding:10px 28px;border-radius:8px;border:0;background:#5fb8a4;color:#121211;font-weight:700}
p{color:#e87070}</style></head><body><h1>AI HUD</h1>
<form method="POST" action="/login"><input name="pin" type="tel" pattern="[0-9]*" maxlength="8" autofocus placeholder="PIN"><br>
<button>Entrar</button></form>${msg ? `<p>${msg}</p>` : ''}</body></html>`;

module.exports = { allowed, createLoginGuard, loginPage };
