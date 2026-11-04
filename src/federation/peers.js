// Hub: junta os dados de outros PCs (secundários) que rodam este mesmo servidor.
// No config.json do PC principal:
//   "peers": [{ "name": "PC-Trabalho", "url": "http://192.168.5.40:8787", "token": "<token do config.json de lá>" }]
// O principal consulta cada secundário a cada 10 s e repassa as ações (responder, permissões,
// abrir no PC, detalhes) ao PC dono da sessão. Ids de sessões remotas ganham o prefixo "m<n>:".
const fs = require('fs');
const { call } = require('./client');
const { mergeSnapshots } = require('./merge');

const POLL_MS = 10e3; // secundários com versão antiga do HUD (sem long-polling)
const WAIT_S = 25;      // espera máxima de uma consulta com ?desde=
const STALE_MS = 60e3; // sem resposta há mais que isso: o PC aparece como fora do ar

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

  // Acompanha cada secundário. Os que informam a versão do snapshot (esta versão do HUD) são consultados
  // com ?desde=<versão>: o secundário só responde quando algo muda (ou após WAIT_S); versões antigas,
  // a cada 10 s. onUpdate() avisa o coletor deste PC para refazer o snapshot na hora.
  start(onUpdate = () => {}) {
    for (const p of this.list) this.follow(p, onUpdate);
  }

  // Uma volta: consulta, avisa e agenda a próxima (na hora com long-polling; 10 s sem ele ou após falha)
  follow(p, onUpdate) {
    const since = p.version ? `?desde=${encodeURIComponent(p.version)}&espera=${WAIT_S}` : '';
    return this.poll(p, since).then((changed) => {
      if (changed) onUpdate();
      this.schedule(() => this.follow(p, onUpdate), p.version && !p.error ? 0 : POLL_MS);
    });
  }

  schedule(fn, ms) {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
  }

  // Uma consulta; resolve true se o snapshot do secundário chegou
  poll(p, since = '') {
    return call(p, 'GET', '/api/snapshot' + since, null, since ? (WAIT_S + 10) * 1000 : 8000).then((r) => {
      if (r.status === 200 && r.json) {
        p.snap = r.json; p.at = Date.now(); p.error = null; p.version = r.json.version || null;
        this.rememberOllamas(p);
        return true;
      }
      p.error = r.status === 401 ? 'token inválido' : `HTTP ${r.status}`;
      return false;
    }, (e) => { p.error = e.message; return false; });
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
