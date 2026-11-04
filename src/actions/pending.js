// Registro único do que está pendente entre o HUD e as sessões, gravado em data/pending.json:
//   replies     respostas enfileiradas para o hook-stop entregar      chave da sessão -> { text, at }
//   listening   hooks esperando resposta (sessão parada)               chave da sessão -> { tool, until, seen }
//   permissions pedidos de permissão segurados no modo remoto          id -> { session, tool, summary, at, decision, seen }
// Um reinício do servidor não perde nada: o hook continua consultando e encontra o que deixou.
// Mudanças importantes gravam na hora; "ainda estou aqui" (seen) grava em até 5 s.
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('../infra/store');

const SECTIONS = ['replies', 'listening', 'permissions'];

function createPendingStore(file) {
  const saved = readJson(file, {});
  // Instalações anteriores guardavam só a fila de respostas, em replies.json
  if (!fs.existsSync(file)) saved.replies = readJson(path.join(path.dirname(file), 'replies.json'), {});
  const maps = Object.fromEntries(SECTIONS.map((name) => [name, new Map(Object.entries(saved[name] || {}))]));
  let dirty = null;

  const save = () => {
    if (dirty) { clearTimeout(dirty); dirty = null; }
    writeJson(file, Object.fromEntries(SECTIONS.map((name) => [name, Object.fromEntries(maps[name])])));
  };
  const touch = () => {
    if (dirty) return;
    dirty = setTimeout(save, 5000);
    if (dirty.unref) dirty.unref();
  };

  function section(name) {
    const map = maps[name];
    return {
      get: (k) => map.get(k),
      has: (k) => map.has(k),
      set(k, v) { map.set(k, v); save(); },
      delete(k) { if (map.delete(k)) save(); },
      entries: () => map.entries(),
      values: () => map.values(),
      // O objeto guardado mudou só em "seen": grava sem pressa
      touch,
    };
  }

  return { section, save };
}

module.exports = { createPendingStore };
