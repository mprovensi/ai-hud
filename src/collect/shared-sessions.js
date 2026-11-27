// Leitura leve em cache dos registros de sessões compartilhadas (`<cwd>/.ai-workspace/sessions/*.json`).
// Camada collect/: somente leitura, usado para costurar histórico unificado e recolher cards substituídos.
const fs = require('fs');
const path = require('path');
const { isValidSessionId } = require('../core/shared-session');

function createSharedSessionIndex() {
  // Cache por diretório `<cwd>/.ai-workspace/sessions` invalidado por mtime do diretório + arquivos
  const dirCache = new Map();

  function readDirRecords(cwd) {
    if (!cwd) return [];
    const dir = path.join(path.resolve(cwd), '.ai-workspace', 'sessions');
    let dirStat;
    try { dirStat = fs.statSync(dir); } catch { return []; }
    if (!dirStat.isDirectory()) return [];

    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    if (!names.length) return [];

    // Assinatura rápida: dir mtime + mtimes/sizes de cada arquivo (normalmente 1–10 arquivos)
    let sig = `${dirStat.mtimeMs}`;
    const fileList = [];
    for (const n of names) {
      const fp = path.join(dir, n);
      try {
        const st = fs.statSync(fp);
        sig += `|${n}:${st.mtimeMs}:${st.size}`;
        fileList.push(fp);
      } catch {}
    }

    const cached = dirCache.get(dir);
    if (cached && cached.sig === sig) return cached.records;

    const records = [];
    for (const fp of fileList) {
      try {
        const r = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (r && typeof r === 'object' && isValidSessionId(r.id) && Array.isArray(r.natives) && r.natives.length) {
          records.push(r);
        }
      } catch {}
    }
    dirCache.set(dir, { sig, records });
    return records;
  }

  // Constrói índice a partir das sessões carregadas pelo collector
  function indexForSessions(sessions) {
    const list = Array.isArray(sessions) ? sessions.filter((s) => s && !s.subagent) : [];
    const byId = new Map();
    const cwds = new Set();
    for (const s of list) {
      byId.set(s.id, s);
      if (s.cwd) cwds.add(s.cwd);
    }

    const byNativeId = new Map();
    const supersededIds = new Set();
    const chainByHeadId = new Map();
    const redirectToHead = new Map();

    for (const cwd of cwds) {
      for (const rec of readDirRecords(cwd)) {
        const present = rec.natives.filter((nid) => byId.has(nid));
        if (!present.length) continue;
        // A sessão "cabeça" (driver ativo) é o último native presente na ordem do handoff
        const headId = present[present.length - 1];
        const chain = present.map((nid) => byId.get(nid)).filter(Boolean);
        const tools = [];
        for (const seg of chain) {
          if (!tools.length || tools[tools.length - 1] !== seg.tool) tools.push(seg.tool);
        }
        const info = {
          record: rec,
          headId,
          chain,
          tools,
        };
        chainByHeadId.set(headId, info);
        for (const nid of present) {
          byNativeId.set(nid, info);
          if (nid !== headId) {
            supersededIds.add(nid);
            redirectToHead.set(nid, headId);
          }
        }
      }
    }

    return { byNativeId, supersededIds, chainByHeadId, redirectToHead };
  }

  return { indexForSessions };
}

module.exports = { createSharedSessionIndex };
