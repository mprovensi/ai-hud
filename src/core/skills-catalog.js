// Regras puras para catálogo e compartilhamento de Skills e Plugins (Claude Code, Codex CLI, Antigravity).
// Camada core/: zero I/O, determinístico e 100% testável.

function sanitizeSkillName(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s || s === '.' || s === '..' || s.includes('..') || s.includes('/') || s.includes('\\')) return '';
  return s.slice(0, 80);
}

function parseSkillFrontmatter(raw) {
  const text = String(raw || '');
  const out = { name: '', description: '' };
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const body = fm[1];
    const nm = /^\s*name:\s*["']?([^\r\n"']+)/m.exec(body);
    if (nm) out.name = nm[1].trim();
    // Suporta description em linha única ou bloco `>` / `|`
    const dm = /^\s*description:\s*(.*)$/m.exec(body);
    if (dm) {
      let val = dm[1].trim();
      if (val === '>' || val === '|' || val === '>-' || val === '|-') {
        const after = body.slice(dm.index + dm[0].length).split(/\r?\n/);
        const parts = [];
        for (const line of after) {
          if (!line.trim()) continue;
          if (/^\s+/.test(line)) parts.push(line.trim());
          else break;
        }
        val = parts.join(' ');
      } else {
        val = val.replace(/^["']|["']$/g, '').trim();
      }
      out.description = val.slice(0, 180);
    }
  }
  if (!out.description) {
    const line = text
      .replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('---'));
    if (line) out.description = line.slice(0, 180);
  }
  return out;
}

function compareSemver(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function buildCrossAiSkillPrompt({ cmd, name, skillFile, pluginName = '', agents = [] }) {
  const label = cmd || `/${name}`;
  const lines = [
    `Execute a skill \`${label}\`${pluginName ? ` (plugin ${pluginName})` : ''}.`,
    `Leia obrigatoriamente o arquivo de instruções completo antes de agir: \`${skillFile}\`.`,
  ];
  if (Array.isArray(agents) && agents.length) {
    lines.push(`Referências auxiliares de agentes do plugin disponíveis na mesma pasta raiz: ${agents.map((a) => `\`${a}\``).join(', ')}.`);
  }
  lines.push('Siga fielmente o fluxo, scripts e validações definidos na skill.');
  return lines.join('\n');
}

module.exports = {
  sanitizeSkillName,
  parseSkillFrontmatter,
  compareSemver,
  buildCrossAiSkillPrompt,
};
