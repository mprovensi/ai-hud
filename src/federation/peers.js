// Hub: junta os dados de outros PCs (secundários) que rodam este mesmo servidor.
// No config.json do PC principal:
//   "peers": [{ "name": "PC-Trabalho", "url": "http://192.168.5.40:8787", "token": "<token do config.json de lá>" }]
// O principal consulta cada secundário a cada 10 s e repassa as ações (responder, permissões,
// abrir no PC, detalhes) ao PC dono da sessão. Ids de sessões remotas ganham o prefixo "m<n>:".
const fs = require('fs');
const { readJson, writeJson } = require('../infra/store');
const { call } = require('./client');
const { mergeSnapshots } = require('./merge');

const POLL_MS = 10e3; // secundários com versão antiga do HUD (sem long-polling)
const WAIT_S = 25;      // espera máxima de uma consulta com ?desde=
const STALE_MS = 60e3; // sem resposta há mais que isso: o PC aparece como fora do ar
const CACHE_SAVE_MS = 30e3; // intervalo mínimo entre gravações de cache em disco por peer

class Peers {
  // ollamaFile: onde lembrar quais secundários têm Ollama, para o cartão mostrá-los como sem
  // conexão quando o PC não responde (mesmo logo após reiniciar o HUD)
  // cacheFile: guarda o último snapshot resumido de cada secundário para preservar totais/gráficos quando ele hiberna
  constructor(list, ollamaFile, cacheFile = null) {
    this.ollamaFile = ollamaFile;
    this.cacheFile = cacheFile;
    let known = {};
    try { known = JSON.parse(fs.readFileSync(ollamaFile, 'utf8')) || {}; } catch {}
    const cached = cacheFile ? readJson(cacheFile, {}) : {};
    this.list = (list || []).filter((p) => p && p.url && p.token)
      .map((p, i) => {
        const name = p.name || `PC ${i + 2}`;
        const saved = Array.isArray(known[name]) ? known[name] : [];
        const savedSnap = cached && cached[name] && cached[name].snap ? cached[name].snap : null;
        return { name, url: p.url, token: p.token, ollama: p.ollama, i, snap: savedSnap, at: 0, error: null,
          cacheSavedAt: 0,
          ollamas: p.ollama === false ? [] : saved.length ? saved : p.ollama === true ? [{ machine: name, version: null, installed: null }] : [] };
      });
  }

  // Acompanha cada secundário. Os que informam a versão do snapshot (esta versão do HUD) são consultados
  // com ?local=1&desde=<versão>: devolvem só os dados locais (sem loop em multi-hub) e só respondem
  // quando algo muda (ou após WAIT_S); versões antigas, a cada 10 s.
  start(onUpdate = () => {}) {
    for (const p of this.list) this.follow(p, onUpdate);
  }

  // Uma volta: consulta, avisa e agenda a próxima (na hora com long-polling; 10 s sem ele ou após falha)
  follow(p, onUpdate) {
    if (this._stopped) return Promise.resolve();
    const query = p.version ? `?local=1&desde=${encodeURIComponent(p.version)}&espera=${WAIT_S}` : '?local=1';
    return this.poll(p, query).then((changed) => {
      if (this._stopped) return;
      if (changed) onUpdate(p);
      this.schedule(() => this.follow(p, onUpdate), p.version && !p.error ? 0 : POLL_MS);
    });
  }

  schedule(fn, ms) {
    if (this._stopped) return;
    if (!this._timers) this._timers = new Set();
    const t = setTimeout(() => {
      this._timers.delete(t);
      if (!this._stopped) fn();
    }, ms);
    if (t.unref) t.unref();
    this._timers.add(t);
  }

  stop() {
    this._stopped = true;
    if (this._timers) {
      for (const t of this._timers) clearTimeout(t);
      this._timers.clear();
    }
  }

  // Uma consulta; resolve true se o snapshot do secundário chegou
  poll(p, query = '?local=1') {
    return call(p, 'GET', '/api/snapshot' + query, null, query.includes('desde=') ? (WAIT_S + 10) * 1000 : 8000).then((r) => {
      if (r.status === 200 && r.json) {
        p.snap = r.json; p.at = Date.now(); p.error = null; p.version = r.json.version || null;
        this.rememberOllamas(p);
        this.rememberSnapshot(p);
        return true;
      }
      p.error = r.status === 401 ? 'token inválido' : `HTTP ${r.status}`;
      return false;
    }, (e) => { p.error = e.message; return false; });
  }

  // Persiste um resumo leve do snapshot (sem sessões active) para o hub 24/7 manter gráficos e histórico offline
  rememberSnapshot(p) {
    if (!this.cacheFile || !p.snap) return;
    const now = Date.now();
    if (p.cacheSavedAt && now - p.cacheSavedAt < CACHE_SAVE_MS) return;
    p.cacheSavedAt = now;
    const all = {};
    for (const q of this.list) {
      if (!q.snap) continue;
      const s = q.snap;
      all[q.name] = {
        at: q.at || now,
        snap: {
          now: s.now || q.at || now, tz: s.tz,
          today: s.today, sessionsToday: s.sessionsToday,
          costs: s.costs,
          hours: s.hours, days: s.days,
          recent: Array.isArray(s.recent) ? s.recent.slice(0, 40) : [],
          quotas: s.quotas, burn: s.burn,
        },
      };
    }
    try { writeJson(this.cacheFile, all); } catch {}
  }

  pollAll() { return Promise.all(this.list.map((p) => this.poll(p))); }

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

  // Junta o snapshot local com os dos secundários
  merge(local, localName) {
    return mergeSnapshots({ local, localName, list: this.list, live: this.live(Date.now()), ollamasFor: (p, connected) => this.ollamasForPeer(p, connected) });
  }

  // Repasse de ações; resolve { status, json, text }
  forward(peer, method, route, body) { return call(peer, method, route, body, 30e3); }
  broadcast(method, route, body) { return Promise.all(this.list.map((p) => call(p, method, route, body).catch(() => null))); }
}

module.exports = { Peers };
