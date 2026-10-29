// Hub: junta os dados de outros PCs (secundários) que rodam este mesmo servidor.
// No config.json do PC principal:
//   "peers": [{ "name": "PC-Trabalho", "url": "http://192.168.5.40:8787", "token": "<token do config.json de lá>" }]
// O principal consulta cada secundário a cada 10 s e repassa as ações (responder, permissões,
// abrir no PC, detalhes) ao PC dono da sessão. Ids de sessões remotas ganham o prefixo "m<n>:".
const fs = require('fs');
const http = require('http');

const POLL_MS = 10e3;
const STALE_MS = 60e3; // sem resposta há mais que isso: o PC aparece como fora do ar
const ORDER = { permission: 0, closed: 2 };

function compareSessions(a, b) {
  const priority = (ORDER[a.state] ?? 1) - (ORDER[b.state] ?? 1);
  const recent = (b.end || 0) - (a.end || 0);
  const aId = String(a.id || ''), bId = String(b.id || '');
  return priority || recent || (aId < bId ? -1 : aId > bId ? 1 : 0);
}

function mergeSeries(target, source) {
  const byTime = new Map(target.map((row) => [row.t, row]));
  for (const row of source || []) {
    const match = byTime.get(row.t);
    if (!match) continue;
    for (const tool of ['Claude Code', 'Codex']) match[tool] += row[tool] || 0;
  }
}

function call(peer, method, route, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, peer.url);
    url.searchParams.set('t', peer.token);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(url, { method, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta')));
    req.on('error', reject);
    req.end(data);
  });
}

class Peers {
  // ollamaFile: onde lembrar quais secundários têm Ollama, para o cartão mostrá-los como sem
  // conexão quando o PC não responde (mesmo logo após reiniciar o HUD)
  constructor(list, ollamaFile) {
    this.ollamaFile = ollamaFile;
    let known = {};
    try { known = JSON.parse(fs.readFileSync(ollamaFile, 'utf8')) || {}; } catch {}
    this.list = (list || []).filter((p) => p && p.url && p.token)
      .map((p, i) => {
        const name = p.name || `PC ${i + 2}`;
        const saved = Array.isArray(known[name]) ? known[name] : [];
        return { name, url: p.url, token: p.token, ollama: p.ollama, i, snap: null, at: 0, error: null,
          ollamas: p.ollama === false ? [] : saved.length ? saved : p.ollama === true ? [{ machine: name, version: null, installed: null }] : [] };
      });
  }

  // Consulta os secundários a cada 10 s
  start() {
    if (!this.list.length) return;
    this.pollAll();
    setInterval(() => this.pollAll(), POLL_MS);
  }

  pollAll() {
    for (const p of this.list) {
      call(p, 'GET', '/api/snapshot').then((r) => {
        if (r.status === 200 && r.json) { p.snap = r.json; p.at = Date.now(); p.error = null; this.rememberOllamas(p); }
        else p.error = r.status === 401 ? 'token inválido' : `HTTP ${r.status}`;
      }, (e) => { p.error = e.message; });
    }
  }

  live(now) { return this.list.filter((p) => p.snap && now - p.at < STALE_MS); }

  // Ollamas que o secundário mandou (com o nome do PC); grava só quando a lista de máquinas muda
  peerOllamas(p) {
    if (p.ollama === false) return [];
    const theirs = p.snap && (Array.isArray(p.snap.ollamas) ? p.snap.ollamas : p.snap.ollama ? [p.snap.ollama] : []) || [];
    return theirs.filter((o) => o && typeof o === 'object').map((o) => ({ ...o,
      machine: theirs.length === 1 ? p.name : o.machine || p.name, models: Array.isArray(o.models) ? o.models : [] }));
  }

  rememberOllamas(p) {
    // Lista vazia durante a inicialização não prova que o Ollama foi desinstalado.
    // Mantém as máquinas conhecidas e os últimos metadados; ollama:false as remove explicitamente.
    const known = new Map((p.ollamas || []).map((o) => [o.machine, o]));
    for (const o of this.peerOllamas(p)) {
      const previous = known.get(o.machine) || {};
      known.set(o.machine, { machine: o.machine, version: o.version || previous.version || null,
        installed: o.installed ?? previous.installed ?? null });
    }
    const list = p.ollama === false ? [] : [...known.values()];
    const changed = JSON.stringify(list) !== JSON.stringify(p.ollamas || []);
    p.ollamas = list;
    if (!changed || !this.ollamaFile) return;
    const all = {};
    for (const q of this.list) if (q.ollamas && q.ollamas.length) all[q.name] = q.ollamas;
    try { fs.writeFileSync(this.ollamaFile, JSON.stringify(all, null, 2)); } catch {}
  }

  ollamasForPeer(p, connected) {
    if (p.ollama === false) return [];
    const current = connected ? this.peerOllamas(p) : [];
    const reported = new Set(current.map((o) => o.machine));
    return current.concat((p.ollamas || []).filter((o) => !reported.has(o.machine)).map((o) => ({
      ...o, online: false, unreachable: !connected, unavailable: connected, models: [], gpu: null,
    })));
  }

  // "m0:<id>" → { peer, rid }; sessão local → null
  byId(id) {
    const m = /^m(\d+):(.+)$/.exec(String(id || ''));
    const peer = m && this.list[Number(m[1])];
    return peer ? { peer, rid: m[2] } : null;
  }

  tag(list, p) { return (list || []).map((s) => ({ ...s, id: `m${p.i}:${s.id}`, machine: p.name })); }

  // Junta o snapshot local com os dos secundários
  merge(local, localName) {
    const now = Date.now();
    const live = this.live(now);
    const out = { ...local };
    out.machines = [{ name: localName, ok: true },
      ...this.list.map((p) => ({ name: p.name, ok: live.includes(p), error: p.error }))];
    const mine = (list) => (list || []).map((s) => ({ ...s, machine: localName }));
    out.active = mine(local.active);
    out.recent = mine(local.recent);
    // Ollama: um item por máquina que tem Ollama (o secundário já manda a lista dele)
    out.ollamas = local.ollama ? [{ ...local.ollama, machine: localName }] : [];
    delete out.ollama;
    for (const p of this.list) {
      // PC sem resposta: o Ollama dele aparece fora do ar, marcado como sem conexão com o PC
      out.ollamas = out.ollamas.concat(this.ollamasForPeer(p, live.includes(p)));
    }
    if (!live.length) return out;

    for (const p of live) {
      out.active = out.active.concat(this.tag(p.snap.active, p));
      out.recent = out.recent.concat(this.tag(p.snap.recent, p));
    }
    out.active.sort(compareSessions);
    out.recent = out.recent.sort((a, b) => b.end - a.end).slice(0, 40);

    // Snapshots podem atravessar a virada da hora/dia: alinha os intervalos pelo timestamp.
    out.today = JSON.parse(JSON.stringify(local.today));
    out.sessionsToday = { ...local.sessionsToday };
    out.hours = local.hours.map((h) => ({ ...h }));
    out.days = local.days.map((d) => ({ ...d }));
    for (const p of live) {
      const s = p.snap;
      for (const tool of Object.keys(out.today)) {
        if (!s.today || !s.today[tool]) continue;
        out.today[tool].fresh += s.today[tool].fresh;
        out.today[tool].cacheRead += s.today[tool].cacheRead;
      }
      for (const tool of Object.keys(out.sessionsToday)) out.sessionsToday[tool] += (s.sessionsToday && s.sessionsToday[tool]) || 0;
      mergeSeries(out.hours, s.hours);
      mergeSeries(out.days, s.days);
    }

    // Cotas: mesma conta nos dois PCs = mesma janela (reset igual) → vale a leitura mais recente
    out.quotas = { ...local.quotas };
    for (const name of ['claude', 'codex']) {
      const reset = (q) => q && q.windows && q.windows.seven_day && q.windows.seven_day.resetsAt;
      let best = local.quotas[name];
      for (const p of live) {
        const q = p.snap.quotas && p.snap.quotas[name];
        if (!q || !reset(q)) continue;
        const same = !reset(best) || Math.abs(reset(q) - reset(best)) < 120e3;
        if (same && (!best || !best.at || (q.at || 0) > best.at)) best = q;
      }
      out.quotas[name] = best;
    }
    return out;
  }

  // Repasse de ações; resolve { status, json, text }
  forward(peer, method, route, body) { return call(peer, method, route, body, 30e3); }
  broadcast(method, route, body) { return Promise.all(this.list.map((p) => call(p, method, route, body).catch(() => null))); }
}

module.exports = { Peers, compareSessions };
